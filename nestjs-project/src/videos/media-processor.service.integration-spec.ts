import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
    const metadata = await service.probeVideo(sampleVideoPath, 'video/mp4');

    expect(metadata.durationSeconds).toBeGreaterThanOrEqual(1.8);
    expect(metadata.durationSeconds).toBeLessThanOrEqual(2.5);
    expect(metadata.width).toBe(320);
    expect(metadata.height).toBe(240);
    expect(metadata.codec).toBe('h264');
  });

  it('extracts a valid JPEG thumbnail buffer via ffmpeg', async () => {
    const jpegBuffer = await service.generateThumbnail(
      sampleVideoPath,
      2,
      'video/mp4',
    );

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
      const jpegBuffer = await service.generateThumbnail(
        shortPath,
        0.4,
        'video/mp4',
      );
      expect(jpegBuffer[0]).toBe(0xff);
      expect(jpegBuffer[1]).toBe(0xd8);
    } finally {
      await fs.unlink(shortPath).catch(() => undefined);
    }
  });

  async function makeTemp(ext: string): Promise<string> {
    return Promise.resolve(
      path.join(os.tmpdir(), `media-${randomUUID()}.${ext}`),
    );
  }

  // Regression matrix: every MIME the upload accepts must still be probed
  // and thumbnailed once the demuxer is forced from the declared type.
  it.each([
    ['video/mp4', 'mp4', ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'], 'h264'],
    [
      'video/quicktime',
      'mov',
      ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'],
      'h264',
    ],
    ['video/webm', 'webm', ['-c:v', 'libvpx', '-b:v', '200k'], 'vp8'],
    [
      'video/x-matroska',
      'mkv',
      ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'],
      'h264',
    ],
  ])(
    'probes and thumbnails %s files',
    async (mimeType, ext, codecArgs, codec) => {
      const file = await makeTemp(ext);
      await execFileAsync('ffmpeg', [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=1.5:size=160x120:rate=10',
        ...codecArgs,
        file,
      ]);
      try {
        const metadata = await service.probeVideo(file, mimeType);
        expect(metadata.codec).toBe(codec);
        expect(metadata.width).toBe(160);
        const jpeg = await service.generateThumbnail(
          file,
          metadata.durationSeconds,
          mimeType,
        );
        expect(jpeg[0]).toBe(0xff);
        expect(jpeg[1]).toBe(0xd8);
      } finally {
        await fs.unlink(file).catch(() => undefined);
      }
    },
    20000,
  );

  it('rejects an image uploaded as video/mp4', async () => {
    const png = await makeTemp('png');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=160x120',
      '-frames:v',
      '1',
      png,
    ]);
    try {
      await expect(service.probeVideo(png, 'video/mp4')).rejects.toThrow();
    } finally {
      await fs.unlink(png).catch(() => undefined);
    }
  });

  it('rejects content that does not match the declared container', async () => {
    const webm = await makeTemp('webm');
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1:size=160x120:rate=10',
      '-c:v',
      'libvpx',
      webm,
    ]);
    try {
      await expect(service.probeVideo(webm, 'video/mp4')).rejects.toThrow();
    } finally {
      await fs.unlink(webm).catch(() => undefined);
    }
  });

  describe('when the input is a URL', () => {
    let server: Server;
    let baseUrl: string;
    const requested: string[] = [];

    beforeAll(async () => {
      server = createServer((req, res) => {
        requested.push(req.url ?? '');
        if (req.url?.startsWith('/original.mp4')) {
          // An HLS playlist disguised as the uploaded MP4.
          res.writeHead(200, { 'Content-Type': 'video/mp4' });
          res.end(
            `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\n${baseUrl}/canary-ssrf.ts\n#EXT-X-ENDLIST\n`,
          );
          return;
        }
        res.writeHead(404);
        res.end();
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      await new Promise((r) => server.close(r));
    });

    it('does not follow URLs referenced by a playlist disguised as video/mp4', async () => {
      await expect(
        service.probeVideo(`${baseUrl}/original.mp4`, 'video/mp4'),
      ).rejects.toThrow();
      await expect(
        service.generateThumbnail(`${baseUrl}/original.mp4`, 1, 'video/mp4'),
      ).rejects.toThrow();

      expect(requested.some((u) => u.includes('canary-ssrf'))).toBe(false);
    });
  });
});
