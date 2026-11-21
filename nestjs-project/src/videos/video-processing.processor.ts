import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, type OnApplicationShutdown } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job, UnrecoverableError } from 'bullmq';
import { Repository } from 'typeorm';
import { S3StorageService } from '../storage/s3-storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { MediaProcessorService, redactUrls } from './media-processor.service';
import {
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from './videos-queue.constants';

@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 2 })
export class VideoProcessingProcessor
  extends WorkerHost
  implements OnApplicationShutdown
{
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: S3StorageService,
    private readonly mediaProcessor: MediaProcessorService,
  ) {
    super();
  }

  // @nestjs/bullmq closes the worker (waiting for active jobs) on the same
  // hook; the log makes a graceful stop visible in `docker compose logs`.
  onApplicationShutdown(signal?: string): void {
    this.logger.log(
      `Shutting down (${signal ?? 'close'}); active jobs finish before exit`,
    );
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });

    if (!video) {
      this.logger.warn(
        `Video ${videoId} not found in DB; skipping job ${job.id}`,
      );
      return;
    }

    // A job can run again after its video reached a final state (a stalled
    // job, a lost completion, or a video the sweep already failed): the row
    // wins, and nothing is redone or overwritten.
    if (video.status !== VideoStatus.PROCESSING || !video.storage_key) {
      this.logger.warn(
        `Video ${videoId} is ${video.status}, not processing; skipping job ${job.id}`,
      );
      return;
    }

    const inputUrl = await this.storageService.getPresignedGetUrl(
      video.storage_key,
      900,
    );
    // The MIME stored at initiate drives the demuxer (see MediaProcessorService).
    const metadata = await this.mediaProcessor.probeVideo(
      inputUrl,
      video.mime_type,
    );
    const thumbnailBuffer = await this.mediaProcessor.generateThumbnail(
      inputUrl,
      metadata.durationSeconds,
      video.mime_type,
    );

    const thumbnailKey = `thumbnails/${video.channel_id}/${video.id}/thumb.jpg`;
    await this.storageService.putObject(
      thumbnailKey,
      thumbnailBuffer,
      'image/jpeg',
    );

    const done = await this.videoRepository.update(
      { id: videoId, status: VideoStatus.PROCESSING },
      {
        status: VideoStatus.READY,
        thumbnail_key: thumbnailKey,
        duration_seconds: metadata.durationSeconds,
        width: metadata.width,
        height: metadata.height,
        codec: metadata.codec,
        processing_error: null,
      },
    );
    if (done.affected !== 1) {
      this.logger.warn(
        `Video ${videoId} left processing while job ${job.id} ran; result discarded`,
      );
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessingJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 1;
    // An UnrecoverableError (e.g. a job that stalled more than maxStalledCount)
    // is final even with attempts left; without this the video stays in
    // processing forever.
    const final =
      job.attemptsMade >= maxAttempts || error instanceof UnrecoverableError;
    const reason = redactUrls(error.message);
    if (!final) {
      this.logger.warn(
        `Job ${job.id} attempt ${job.attemptsMade}/${maxAttempts} failed: ${reason}`,
      );
      return;
    }

    this.logger.error(
      `Job ${job.id} exhausted retries for video ${job.data.videoId}: ${reason}`,
    );

    // Conditional: a re-delivered job failing after the video became ready
    // must not take it down. The listener's promise is ignored by the worker
    // (EventEmitter), so a rejection here would be unhandled and crash the
    // process; the maintenance sweep fails the video later instead.
    try {
      await this.videoRepository.update(
        { id: job.data.videoId, status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.FAILED,
          // Defence in depth: no error path may persist a signed URL.
          processing_error: reason.slice(0, 1000),
        },
      );
    } catch (err) {
      this.logger.error(
        `Could not mark video ${job.data.videoId} failed (${(err as Error).message}); the maintenance sweep will`,
      );
    }
  }
}
