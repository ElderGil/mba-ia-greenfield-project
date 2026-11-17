import { Injectable } from '@nestjs/common';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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

@Injectable()
export class MediaProcessorService {
  async probeVideo(inputUrlOrPath: string): Promise<VideoProbeMetadata> {
    const { stdout } = await execFileAsync(
      'ffprobe',
      [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_format',
        '-show_streams',
        inputUrlOrPath,
      ],
      { timeout: 60_000, maxBuffer: 5 * 1024 * 1024 },
    );

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
  ): Promise<Buffer> {
    const seekSeconds = durationSeconds >= 1 ? 1 : 0;
    const outputPath = path.join(os.tmpdir(), `thumb-${randomUUID()}.jpg`);

    try {
      await execFileAsync(
        'ffmpeg',
        [
          '-y',
          '-ss',
          String(seekSeconds),
          '-i',
          inputUrlOrPath,
          '-vframes',
          '1',
          '-q:v',
          '2',
          '-f',
          'image2',
          outputPath,
        ],
        { timeout: 60_000, maxBuffer: 5 * 1024 * 1024 },
      );

      const buffer = await fs.readFile(outputPath);
      if (buffer.length === 0) {
        throw new Error('Generated thumbnail file is empty');
      }
      return buffer;
    } finally {
      await fs.unlink(outputPath).catch(() => undefined);
    }
  }
}
