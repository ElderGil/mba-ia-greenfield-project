import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const TOOL_OPTIONS = { timeout: 60_000, maxBuffer: 5 * 1024 * 1024 };

/**
 * Replaces every URL with <url>. The worker reads media through presigned
 * URLs, and tool errors echo them back with the access key id, the internal
 * host and a valid signature; those messages end up in processing_error,
 * which the owner can read.
 */
export function redactUrls(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, '<url>');
}

// execFile's own message is the whole command line (URL included), and the
// stderr of ffmpeg starts with its banner; keep only the redacted last
// error lines.
async function runTool(
  tool: 'ffprobe' | 'ffmpeg',
  args: string[],
): Promise<{ stdout: string }> {
  try {
    return await execFileAsync(tool, args, TOOL_OPTIONS);
  } catch (err) {
    const e = err as { stderr?: string; killed?: boolean; code?: unknown };
    const detail = e.killed
      ? `timed out after ${TOOL_OPTIONS.timeout / 1000}s`
      : redactUrls(e.stderr ?? '')
          .trim()
          .split('\n')
          .slice(-2)
          .join(' | ') || `exit code ${String(e.code)}`;
    throw new Error(`${tool} failed: ${detail}`.slice(0, 280));
  }
}

export interface VideoProbeMetadata {
  durationSeconds: number;
  width: number | null;
  height: number | null;
  codec: string | null;
}

interface FfprobeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  duration?: string;
}

interface FfprobeOutput {
  format?: {
    duration?: string;
  };
  streams?: FfprobeStream[];
}

// The demuxer is forced from the MIME the upload declared. Left to
// auto-detection, ffprobe/ffmpeg accept images (PNG/GIF) as "video" and
// open an HLS playlist disguised as .mp4, fetching every URL it lists from
// inside the worker (SSRF).
const DEMUXER_BY_MIME: Readonly<Record<string, string>> = {
  'video/mp4': 'mov',
  'video/quicktime': 'mov',
  'video/webm': 'matroska',
  'video/x-matroska': 'matroska',
};

// `V` (capital) selects video streams that are not attached pictures: the
// cover art of an audio file is listed as a video stream, and would
// otherwise pass as the video (an mp3-like file published as "video").
// ffprobe and ffmpeg use the same specifier, so the thumbnail comes from the
// track the metadata describes.
const VIDEO_TRACK = 'V:0';

function inputArgs(inputUrlOrPath: string, mimeType: string): string[] {
  const demuxer = DEMUXER_BY_MIME[mimeType];
  if (!demuxer) {
    throw new Error(`Unsupported media type for processing: ${mimeType}`);
  }
  // Only the protocol the input itself uses may be opened.
  const protocols = /^https?:\/\//i.test(inputUrlOrPath)
    ? 'http,https,tcp,tls'
    : 'file';
  return [
    '-protocol_whitelist',
    protocols,
    '-f',
    demuxer,
    '-i',
    inputUrlOrPath,
  ];
}

@Injectable()
export class MediaProcessorService {
  async probeVideo(
    inputUrlOrPath: string,
    mimeType: string,
  ): Promise<VideoProbeMetadata> {
    const { stdout } = await runTool('ffprobe', [
      '-v',
      'error',
      '-print_format',
      'json',
      '-select_streams',
      VIDEO_TRACK,
      '-show_entries',
      'format=duration:stream=codec_type,codec_name,width,height,duration',
      ...inputArgs(inputUrlOrPath, mimeType),
    ]);

    const parsed = JSON.parse(stdout) as FfprobeOutput;
    const videoStream = parsed.streams?.find(
      (stream) => stream.codec_type === 'video',
    );
    if (!videoStream) {
      throw new Error('No video stream found in media file');
    }

    const rawDuration = parsed.format?.duration ?? videoStream.duration ?? '0';
    const durationSeconds = Number(rawDuration);

    return {
      durationSeconds: Number.isFinite(durationSeconds)
        ? Math.max(0, durationSeconds)
        : 0,
      width: typeof videoStream.width === 'number' ? videoStream.width : null,
      height:
        typeof videoStream.height === 'number' ? videoStream.height : null,
      codec: videoStream.codec_name ?? null,
    };
  }

  async generateThumbnail(
    inputUrlOrPath: string,
    durationSeconds: number,
    mimeType: string,
  ): Promise<Buffer> {
    // Seeking to exactly the duration yields no frame (a 1.0 s clip has none
    // at 1 s) and ffmpeg still exits 0, so stay inside the clip and fall back
    // to the first frame when nothing came out.
    const preferred = Math.min(1, durationSeconds / 2);
    const first = await this.extractFrame(inputUrlOrPath, mimeType, preferred);
    if (first) return first;
    if (preferred > 0) {
      const fallback = await this.extractFrame(inputUrlOrPath, mimeType, 0);
      if (fallback) return fallback;
    }
    throw new Error(
      'ffmpeg failed: no frame could be extracted for the thumbnail',
    );
  }

  private async extractFrame(
    inputUrlOrPath: string,
    mimeType: string,
    seekSeconds: number,
  ): Promise<Buffer | null> {
    const outputPath = path.join(os.tmpdir(), `thumb-${randomUUID()}.jpg`);

    try {
      await runTool('ffmpeg', [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        String(seekSeconds),
        ...inputArgs(inputUrlOrPath, mimeType),
        '-map',
        `0:${VIDEO_TRACK}`,
        '-vframes',
        '1',
        '-q:v',
        '2',
        '-f',
        'image2',
        outputPath,
      ]);

      const buffer = await fs.readFile(outputPath).catch(() => null);
      return buffer && buffer.length > 0 ? buffer : null;
    } finally {
      await fs.unlink(outputPath).catch(() => undefined);
    }
  }
}
