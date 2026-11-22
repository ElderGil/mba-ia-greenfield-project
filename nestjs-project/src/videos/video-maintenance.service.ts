import { InjectQueue } from '@nestjs/bullmq';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { type FindOptionsWhere, LessThan, MoreThan, Repository } from 'typeorm';
import videoConfig from '../config/video.config';
import { S3StorageService } from '../storage/s3-storage.service';
import { Video, VideoStatus } from './entities/video.entity';
import { redactUrls } from './media-processor.service';
import {
  processVideoJobId,
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from './videos-queue.constants';
import { discardDraftUpload } from './video-upload-session';

export interface SweepResult {
  abortedDrafts: number;
  failedOrphans: number;
}

// Rows read per query; a run pages through every eligible row.
const SWEEP_PAGE = 100;
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
 *
 * A multipart session that outlives its row (process stopped between the
 * database and S3 calls) is left to the storage's own expiry of incomplete
 * uploads: S3-compatible stores cannot list a bucket's sessions reliably
 * (MinIO requires the exact object name), and only a conditional claim on
 * the row may abort a session a row still references.
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
    let removed = 0;
    const where = { status: VideoStatus.DRAFT, created_at: LessThan(cutoff) };
    await this.forEachEligible(where, async (draft) => {
      try {
        // Same claim as complete: a draft completed meanwhile is skipped.
        if (
          await discardDraftUpload(
            this.videoRepository,
            this.storageService,
            draft,
          )
        ) {
          removed++;
        }
      } catch (err) {
        // Background task: keep the row so the next sweep retries it.
        this.logger.warn(
          `Could not remove stale draft ${draft.id}: ${redactUrls((err as Error).message)}`,
        );
      }
    });
    return removed;
  }

  private async failOrphanedProcessing(now: Date): Promise<number> {
    const cutoff = new Date(
      now.getTime() - this.config.processingStuckMinutes * 60_000,
    );
    let failed = 0;
    const where = {
      status: VideoStatus.PROCESSING,
      updated_at: LessThan(cutoff),
    };
    await this.forEachEligible(where, async (video) => {
      const job = await this.processingQueue.getJob(
        processVideoJobId(video.id),
      );
      if (job && LIVE_JOB_STATES.has(await job.getState())) return;

      // Same predicate as the read: a row touched since is left alone.
      const res = await this.videoRepository.update(
        { id: video.id, ...where },
        {
          status: VideoStatus.FAILED,
          processing_error:
            'Processing job was lost (worker or API stopped mid-flight); upload the video again',
        },
      );
      if (res.affected === 1) failed++;
    });
    return failed;
  }

  /**
   * Visits every row matching `where`, paging by id (keyset). A fixed
   * "oldest N" window let rows that keep failing (or a backlog of live
   * jobs) hide every row behind them forever; memory stays bounded by the
   * page size, and rows deleted while paging do not shift the cursor.
   */
  private async forEachEligible(
    where: FindOptionsWhere<Video>,
    visit: (video: Video) => Promise<void>,
  ): Promise<void> {
    let after: string | undefined;
    for (;;) {
      const page = await this.videoRepository.find({
        where: after ? { ...where, id: MoreThan(after) } : where,
        order: { id: 'ASC' },
        take: SWEEP_PAGE,
      });
      for (const video of page) {
        await visit(video);
      }
      if (page.length < SWEEP_PAGE) return;
      after = page[page.length - 1].id;
    }
  }
}
