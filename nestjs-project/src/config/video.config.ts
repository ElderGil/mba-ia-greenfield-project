import { registerAs } from '@nestjs/config';

const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024 * 1024; // 10 GiB
const DEFAULT_PART_SIZE_BYTES = 10 * 1024 * 1024; // 10 MiB

export default registerAs('video', () => ({
  maxFileSizeBytes: parseInt(
    process.env.VIDEO_MAX_SIZE_BYTES || String(DEFAULT_MAX_FILE_SIZE_BYTES),
    10,
  ),
  defaultPartSizeBytes: parseInt(
    process.env.VIDEO_UPLOAD_PART_SIZE_BYTES || String(DEFAULT_PART_SIZE_BYTES),
    10,
  ),
  presignedUrlExpiresInSeconds: parseInt(
    process.env.VIDEO_PRESIGNED_URL_EXPIRES_IN || '900',
    10,
  ),
  // Open drafts hold an S3 multipart upload; cap them per channel.
  maxOpenDrafts: parseInt(process.env.VIDEO_MAX_OPEN_DRAFTS || '5', 10),
  // Maintenance sweep (worker): abandoned drafts and processing videos
  // whose job was lost.
  draftTtlHours: parseInt(process.env.VIDEO_DRAFT_TTL_HOURS || '24', 10),
  processingStuckMinutes: parseInt(
    process.env.VIDEO_PROCESSING_STUCK_MINUTES || '30',
    10,
  ),
}));
