import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { S3StorageService } from '../storage/s3-storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { MediaProcessorService } from './media-processor.service';
import {
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from './videos-queue.constants';

@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 2 })
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: S3StorageService,
    private readonly mediaProcessor: MediaProcessorService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    const { videoId, channelId, storageKey } = job.data;
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });

    if (!video) {
      this.logger.warn(
        `Video ${videoId} not found in DB; skipping job ${job.id}`,
      );
      return;
    }

    const inputUrl = await this.storageService.getPresignedGetUrl(
      storageKey,
      900,
    );
    const metadata = await this.mediaProcessor.probeVideo(inputUrl);
    const thumbnailBuffer = await this.mediaProcessor.generateThumbnail(
      inputUrl,
      metadata.durationSeconds,
    );

    const thumbnailKey = `thumbnails/${channelId}/${videoId}/thumb.jpg`;
    await this.storageService.putObject(
      thumbnailKey,
      thumbnailBuffer,
      'image/jpeg',
    );

    await this.videoRepository.update(
      { id: videoId },
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
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoProcessingJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;

    const maxAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < maxAttempts) {
      this.logger.warn(
        `Job ${job.id} attempt ${job.attemptsMade}/${maxAttempts} failed: ${error.message}`,
      );
      return;
    }

    this.logger.error(
      `Job ${job.id} exhausted retries for video ${job.data.videoId}: ${error.message}`,
    );

    await this.videoRepository.update(
      { id: job.data.videoId },
      {
        status: VideoStatus.FAILED,
        processing_error: error.message.slice(0, 1000),
      },
    );
  }
}
