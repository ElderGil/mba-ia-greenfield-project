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
// Completed/failed sweep jobs kept in Redis (about a day at one per 15 min).
export const VIDEO_MAINTENANCE_KEEP_JOBS = 100;

// The job only names the video; the worker reads everything else (storage
// key, channel, MIME, status) from its row, the single source of truth.
// Jobs queued before this change also carry channelId, storageKey and
// mimeType: they are accepted and those fields ignored.
export interface VideoProcessingJobData {
  videoId: string;
}
