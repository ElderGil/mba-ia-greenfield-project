import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { Queue } from 'bullmq';
import {
  PROCESS_VIDEO_JOB,
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from './videos-queue.constants';

@Injectable()
export class VideosQueueService {
  constructor(
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly videoQueue: Queue<VideoProcessingJobData>,
  ) {}

  async enqueueProcessVideo(data: VideoProcessingJobData): Promise<string> {
    const job = await this.videoQueue.add(PROCESS_VIDEO_JOB, data, {
      jobId: `process-video-${data.videoId}`,
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000,
      },
    });
    return String(job.id ?? `process-video-${data.videoId}`);
  }
}
