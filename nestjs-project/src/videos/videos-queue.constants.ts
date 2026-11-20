export const VIDEO_PROCESSING_QUEUE = 'video-processing';
export const PROCESS_VIDEO_JOB = 'process-video';

// One processing job per video; the id makes enqueueing idempotent and lets
// the maintenance sweep find the job of a video.
export function processVideoJobId(videoId: string): string {
  return `${PROCESS_VIDEO_JOB}-${videoId}`;
}

export const VIDEO_MAINTENANCE_QUEUE = 'video-maintenance';
export const VIDEO_MAINTENANCE_SCHEDULER = 'video-maintenance-sweep';
export const VIDEO_MAINTENANCE_EVERY_MS = 15 * 60_000;

export interface VideoProcessingJobData {
  videoId: string;
  channelId: string;
  storageKey: string;
  mimeType: string;
}
