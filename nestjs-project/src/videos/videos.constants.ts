// The one catalog of accepted upload types: the API validates against it and
// names the stored object with its extension; the worker forces ffprobe and
// ffmpeg to its demuxer (never auto-detection, see MediaProcessorService).
export const VIDEO_FORMATS = {
  'video/mp4': { extension: 'mp4', demuxer: 'mov' },
  'video/webm': { extension: 'webm', demuxer: 'matroska' },
  'video/quicktime': { extension: 'mov', demuxer: 'mov' },
  'video/x-matroska': { extension: 'mkv', demuxer: 'matroska' },
} as const satisfies Record<string, { extension: string; demuxer: string }>;

export type VideoMimeType = keyof typeof VIDEO_FORMATS;

export const VIDEO_MIME_TYPES = Object.keys(VIDEO_FORMATS) as VideoMimeType[];

export function videoFormatOf(
  mimeType: string,
): (typeof VIDEO_FORMATS)[VideoMimeType] | undefined {
  return Object.hasOwn(VIDEO_FORMATS, mimeType)
    ? VIDEO_FORMATS[mimeType as VideoMimeType]
    : undefined;
}

export const MAX_MULTIPART_PARTS = 10000;

// Upload initiation is the only video route under the global throttler:
// public media routes stay unlimited because players issue many range
// requests per view.
export const INITIATE_UPLOAD_THROTTLE = { limit: 10, ttl: 60_000 } as const;
