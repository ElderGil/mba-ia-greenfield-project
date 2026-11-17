import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { MediaProcessorService } from './media-processor.service';

const execFileAsync = promisify(execFile);

describe('MediaProcessorService (integration with ffmpeg/ffprobe)', () => {
  const service = new MediaProcessorService();
  let sampleVideoPath: string;

  beforeAll(async () => {
    sampleVideoPath = path.join(os.tmpdir(), `sample-${randomUUID()}.mp4`);
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=2:size=320x240:rate=10',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      sampleVideoPath,
    ]);
  });

  afterAll(async () => {
    await fs.unlink(sampleVideoPath).catch(() => undefined);
  });

  it('extracts duration, resolution, and codec via ffprobe', async () => {
    const metadata = await service.probeVideo(sampleVideoPath);

    expect(metadata.durationSeconds).toBeGreaterThanOrEqual(1.8);
    expect(metadata.durationSeconds).toBeLessThanOrEqual(2.5);
    expect(metadata.width).toBe(320);
    expect(metadata.height).toBe(240);
    expect(metadata.codec).toBe('h264');
  });

  it('extracts a valid JPEG thumbnail buffer via ffmpeg', async () => {
    const jpegBuffer = await service.generateThumbnail(sampleVideoPath, 2);

    expect(jpegBuffer.length).toBeGreaterThan(100);
    // JPEG magic bytes FF D8 FF
    expect(jpegBuffer[0]).toBe(0xff);
    expect(jpegBuffer[1]).toBe(0xd8);
    expect(jpegBuffer[2]).toBe(0xff);
  });

  it('falls back to frame 0s for sub-second videos', async () => {
    const shortPath = path.join(os.tmpdir(), `short-${randomUUID()}.mp4`);
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=0.4:size=160x120:rate=10',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      shortPath,
    ]);

    try {
      const jpegBuffer = await service.generateThumbnail(shortPath, 0.4);
      expect(jpegBuffer[0]).toBe(0xff);
      expect(jpegBuffer[1]).toBe(0xd8);
    } finally {
      await fs.unlink(shortPath).catch(() => undefined);
    }
  });
});
