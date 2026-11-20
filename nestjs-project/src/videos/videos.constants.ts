export const ALLOWED_VIDEO_MIME_TYPES = new Set<string>([
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'video/x-matroska',
]);

export const MIME_TO_EXTENSION: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
};

export const MAX_MULTIPART_PARTS = 10000;

// Upload initiation is the only video route under the global throttler:
// public media routes stay unlimited because players issue many range
// requests per view.
export const INITIATE_UPLOAD_THROTTLE = { limit: 10, ttl: 60_000 } as const;
