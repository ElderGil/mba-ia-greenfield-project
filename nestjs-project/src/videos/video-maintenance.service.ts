import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { LessThan, Repository } from 'typeorm';
import videoConfig from '../config/video.config';
import { S3StorageService } from '../storage/s3-storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import {
  processVideoJobId,
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from './videos-queue.constants';

export interface SweepResult {
  abortedDrafts: number;
  failedOrphans: number;
}

// Bounded per run; the next sweep picks up the rest.
const SWEEP_BATCH = 100;
// States in which the job will still move the video out of processing.
const LIVE_JOB_STATES = new Set([
  'active',
  'waiting',
  'delayed',
  'prioritized',
  'waiting-children',
]);

/**
 * Periodic cleanup run by the worker (VideoMaintenanceProcessor):
 * - drafts never completed keep an S3 multipart upload (and its parts)
 *   forever; past the TTL the upload is aborted and the draft removed;
 * - a video can stay in processing with no job (API stopped between the
 *   claim and the enqueue, or a job lost in Redis); past the threshold,
 *   and only if no live job exists, it is marked failed.
 */
@Injectable()
export class VideoMaintenanceService {
  private readonly logger = new Logger(VideoMaintenanceService.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: S3StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly processingQueue: Queue<VideoProcessingJobData>,
    @Inject(videoConfig.KEY)
    private readonly config: ConfigType<typeof videoConfig>,
  ) {}

  async sweep(now: Date): Promise<SweepResult> {
    const result = {
      abortedDrafts: await this.removeStaleDrafts(now),
      failedOrphans: await this.failOrphanedProcessing(now),
    };
    if (result.abortedDrafts > 0 || result.failedOrphans > 0) {
      this.logger.log(
        `Sweep removed ${result.abortedDrafts} stale draft(s) and failed ${result.failedOrphans} orphaned video(s)`,
      );
    }
    return result;
  }

  private async removeStaleDrafts(now: Date): Promise<number> {
    const cutoff = new Date(
      now.getTime() - this.config.draftTtlHours * 3_600_000,
    );
    const drafts = await this.videoRepository.find({
      where: { status: VideoStatus.DRAFT, created_at: LessThan(cutoff) },
      order: { created_at: 'ASC' },
      take: SWEEP_BATCH,
    });

    let removed = 0;
    for (const draft of drafts) {
      try {
        if (draft.storage_key && draft.upload_id) {
          await this.abortUpload(draft.storage_key, draft.upload_id);
        }
        // Conditional: a draft completed meanwhile is no longer a draft.
        const res = await this.videoRepository.delete({
          id: draft.id,
          status: VideoStatus.DRAFT,
        });
        if (res.affected === 1) removed++;
      } catch (err) {
        // Background task: keep the row so the next sweep retries it.
        this.logger.warn(
          `Could not remove stale draft ${draft.id}: ${(err as Error).message}`,
        );
      }
    }
    return removed;
  }

  private async abortUpload(key: string, uploadId: string): Promise<void> {
    try {
      await this.storageService.abortMultipartUpload(key, uploadId);
    } catch (err) {
      // Already aborted (by a lifecycle rule or a previous sweep): done.
      if ((err as { name?: string }).name === 'NoSuchUpload') return;
      throw err;
    }
  }

  private async failOrphanedProcessing(now: Date): Promise<number> {
    const cutoff = new Date(
      now.getTime() - this.config.processingStuckMinutes * 60_000,
    );
    const stuck = await this.videoRepository.find({
      where: { status: VideoStatus.PROCESSING, updated_at: LessThan(cutoff) },
      order: { updated_at: 'ASC' },
      take: SWEEP_BATCH,
    });

    let failed = 0;
    for (const video of stuck) {
      const job = await this.processingQueue.getJob(
        processVideoJobId(video.id),
      );
      if (job && LIVE_JOB_STATES.has(await job.getState())) continue;

      const res = await this.videoRepository.update(
        { id: video.id, status: VideoStatus.PROCESSING },
        {
          status: VideoStatus.FAILED,
          processing_error:
            'Processing job was lost (worker or API stopped mid-flight); upload the video again',
        },
      );
      if (res.affected === 1) failed++;
    }
    return failed;
  }
}
