import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import {
  INestApplication,
  INestApplicationContext,
  ValidationPipe,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource, Repository } from 'typeorm';
import { AppModule } from '../src/app.module';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { MailService } from '../src/mail/mail.service';
import { S3StorageService } from '../src/storage/s3-storage.service';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  CompleteUploadResponseDto,
  InitiateUploadResponseDto,
  SignUploadPartResponseDto,
  VideoOwnerResponseDto,
  VideoPublicResponseDto,
} from '../src/videos/dto/video-response.dto';
import { Video, VideoStatus } from '../src/videos/entities/video.entity';
import { WorkerModule } from '../src/worker.module';

const execFileAsync = promisify(execFile);

interface ErrorBody {
  statusCode: number;
  error: string;
  message: string | string[];
}

interface LoginBody {
  access_token: string;
  refresh_token: string;
}

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let workerApp: INestApplicationContext;
  let dataSource: DataSource;
  let storageService: S3StorageService;
  let mailService: MailService;
  let videoRepo: Repository<Video>;
  let throttlerStorage: ThrottlerStorageService;
  let sampleMp4: Buffer;
  const createdStorageKeys: string[] = [];

  beforeAll(async () => {
    const tmpMp4 = path.join(os.tmpdir(), `e2e-sample-${randomUUID()}.mp4`);
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'testsrc=duration=1.5:size=320x240:rate=10',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      tmpMp4,
    ]);
    sampleMp4 = await fs.readFile(tmpMp4);
    await fs.unlink(tmpMp4).catch(() => undefined);

    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    const workerFixture = await Test.createTestingModule({
      imports: [WorkerModule],
    }).compile();
    workerApp = await workerFixture.init();

    dataSource = moduleFixture.get(DataSource);
    storageService = moduleFixture.get(S3StorageService);
    mailService = moduleFixture.get(MailService);
    videoRepo = dataSource.getRepository(Video);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  }, 30000);

  afterAll(async () => {
    for (const key of createdStorageKeys) {
      await storageService.deleteObject(key).catch(() => undefined);
    }
    await workerApp.close();
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  let userCounter = 0;
  async function registerConfirmAndLogin(
    emailPrefix = 'video_e2e',
  ): Promise<{ accessToken: string }> {
    const email = `${emailPrefix}_${++userCounter}@example.com`;
    const password = 'password123';

    let confirmationToken = '';
    jest
      .spyOn(mailService, 'sendConfirmationEmail')
      .mockImplementationOnce((_e: string, _n: string, t: string) => {
        confirmationToken = t;
        return Promise.resolve();
      });

    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password })
      .expect(201);

    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: confirmationToken })
      .expect(204);

    const loginRes = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password })
      .expect(200);

    const loginBody = loginRes.body as LoginBody;
    return { accessToken: loginBody.access_token };
  }

  async function pollVideoUntilSettled(
    accessToken: string,
    videoId: string,
    timeoutMs = 20000,
  ): Promise<VideoOwnerResponseDto> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const res = await request(app.getHttpServer())
        .get(`/videos/${videoId}/status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const body = res.body as VideoOwnerResponseDto;
      if (
        body.status === VideoStatus.READY ||
        body.status === VideoStatus.FAILED
      ) {
        return body;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`Timed out waiting for video ${videoId} to settle`);
  }

  it('completes full upload, background FFmpeg processing, 206 Range streaming, thumbnail, and download flow', async () => {
    const { accessToken } = await registerConfirmAndLogin('creator');

    // 1. Initiate upload -> creates draft with unique shortCode
    const initRes = await request(app.getHttpServer())
      .post('/videos/uploads/initiate')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'StreamTube Demo Video',
        filename: 'sample.mp4',
        mimeType: 'video/mp4',
        sizeBytes: sampleMp4.length,
      })
      .expect(201);

    const initBody = initRes.body as InitiateUploadResponseDto;
    const { videoId, shortCode, storageKey } = initBody;
    createdStorageKeys.push(storageKey);

    expect(videoId).toBeDefined();
    expect(shortCode).toMatch(/^[A-Za-z0-9_-]{11}$/);
    expect(initBody.status).toBe(VideoStatus.DRAFT);

    // Draft appears in /videos/me; public routes answer 404 so a shortCode
    // does not reveal that an unpublished video exists
    const myVideos = await request(app.getHttpServer())
      .get('/videos/me')
      .set('Authorization', `Bearer ${accessToken}`)
      .expect(200);
    const myVideosList = myVideos.body as VideoOwnerResponseDto[];
    expect(myVideosList).toHaveLength(1);
    expect(myVideosList[0].status).toBe(VideoStatus.DRAFT);

    for (const suffix of ['', '/stream', '/download', '/thumbnail']) {
      const hidden = await request(app.getHttpServer())
        .get(`/videos/${shortCode}${suffix}`)
        .expect(404);
      expect((hidden.body as ErrorBody).error).toBe('VIDEO_NOT_FOUND');
    }

    // 2. Request presigned part URL and PUT bytes directly to MinIO
    const partRes = await request(app.getHttpServer())
      .post(`/videos/${videoId}/uploads/parts`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ partNumber: 1 })
      .expect(200);

    const partBody = partRes.body as SignUploadPartResponseDto;
    const putRes = await fetch(partBody.presignedUrl, {
      method: 'PUT',
      body: new Uint8Array(sampleMp4),
    });
    expect(putRes.ok).toBe(true);
    const etag = putRes.headers.get('etag');
    expect(etag).toBeTruthy();

    // 3. Complete upload -> transitions to processing and enqueues BullMQ job
    const completeRes = await request(app.getHttpServer())
      .post(`/videos/${videoId}/uploads/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [{ partNumber: 1, etag }] })
      .expect(202);

    const completeBody = completeRes.body as CompleteUploadResponseDto;
    expect(completeBody.status).toBe(VideoStatus.PROCESSING);
    expect(completeBody.jobId).toBe(`process-video-${videoId}`);

    // Re-completing a non-draft video returns 409 VIDEO_INVALID_STATE
    await request(app.getHttpServer())
      .post(`/videos/${videoId}/uploads/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [{ partNumber: 1, etag }] })
      .expect(409);

    // 4. Wait for worker to process metadata + thumbnail
    const settled = await pollVideoUntilSettled(accessToken, videoId);
    expect(settled.status).toBe(VideoStatus.READY);
    expect(settled.durationSeconds).toBeGreaterThanOrEqual(1.3);
    expect(settled.width).toBe(320);
    expect(settled.height).toBe(240);
    expect(settled.codec).toBe('h264');
    expect(settled.thumbnailUrl).toBe(`/videos/${shortCode}/thumbnail`);
    expect(settled).not.toHaveProperty('thumbnailKey');
    createdStorageKeys.push(
      (await videoRepo.findOneByOrFail({ id: videoId })).thumbnail_key!,
    );

    // 5. Public metadata (@Public)
    const publicMeta = await request(app.getHttpServer())
      .get(`/videos/${shortCode}`)
      .expect(200);
    const publicBody = publicMeta.body as VideoPublicResponseDto;
    expect(publicBody.shortCode).toBe(shortCode);
    expect(publicBody.streamUrl).toBe(`/videos/${shortCode}/stream`);
    expect(publicBody.downloadUrl).toBe(`/videos/${shortCode}/download`);
    expect(publicBody.thumbnailUrl).toBe(`/videos/${shortCode}/thumbnail`);

    // 6. Thumbnail endpoint (@Public) returns valid JPEG
    const thumbRes = await request(app.getHttpServer())
      .get(`/videos/${shortCode}/thumbnail`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(thumbRes.headers['content-type']).toContain('image/jpeg');
    const thumbBuf = thumbRes.body as Buffer;
    expect(thumbBuf[0]).toBe(0xff);
    expect(thumbBuf[1]).toBe(0xd8);

    // Revalidation: same ETag answers 304 without a body
    const thumbEtag: string = thumbRes.headers['etag'];
    expect(thumbEtag).toMatch(/^"[^"]+"$/);
    expect(thumbRes.headers['cache-control']).toBe('no-cache');
    await request(app.getHttpServer())
      .get(`/videos/${shortCode}/thumbnail`)
      .set('If-None-Match', thumbEtag)
      .expect(304);

    // 7. Byte-Range streaming (206 Partial Content) without full download
    const streamRes1 = await request(app.getHttpServer())
      .get(`/videos/${shortCode}/stream`)
      .set('Range', 'bytes=0-511')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(206);

    expect(streamRes1.headers['accept-ranges']).toBe('bytes');
    expect(streamRes1.headers['content-range']).toBe(
      `bytes 0-511/${sampleMp4.length}`,
    );
    expect(
      Buffer.compare(streamRes1.body as Buffer, sampleMp4.subarray(0, 512)),
    ).toBe(0);

    const streamRes2 = await request(app.getHttpServer())
      .get(`/videos/${shortCode}/stream`)
      .set('Range', 'bytes=512-1023')
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(206);

    expect(
      Buffer.compare(streamRes2.body as Buffer, sampleMp4.subarray(512, 1024)),
    ).toBe(0);

    // Invalid range -> 416 INVALID_RANGE
    const invalidRange = await request(app.getHttpServer())
      .get(`/videos/${shortCode}/stream`)
      .set('Range', `bytes=${sampleMp4.length + 100}-`)
      .expect(416);
    expect((invalidRange.body as ErrorBody).error).toBe('INVALID_RANGE');
    expect(invalidRange.headers['content-range']).toBe(
      `bytes */${sampleMp4.length}`,
    );

    // 8. Full attachment download (@Public)
    const downloadRes = await request(app.getHttpServer())
      .get(`/videos/${shortCode}/download`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);

    expect(downloadRes.headers['content-disposition']).toBe(
      `attachment; filename="sample.mp4"; filename*=UTF-8''sample.mp4`,
    );
    expect(Buffer.compare(downloadRes.body as Buffer, sampleMp4)).toBe(0);
  }, 30000);

  async function uploadReadyVideo(
    accessToken: string,
    filename: string,
  ): Promise<{ shortCode: string }> {
    const initRes = await request(app.getHttpServer())
      .post('/videos/uploads/initiate')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Regression video',
        filename,
        mimeType: 'video/mp4',
        sizeBytes: sampleMp4.length,
      })
      .expect(201);
    const { videoId, shortCode, storageKey } =
      initRes.body as InitiateUploadResponseDto;
    createdStorageKeys.push(storageKey);

    const partRes = await request(app.getHttpServer())
      .post(`/videos/${videoId}/uploads/parts`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ partNumber: 1 })
      .expect(200);
    const putRes = await fetch(
      (partRes.body as SignUploadPartResponseDto).presignedUrl,
      { method: 'PUT', body: new Uint8Array(sampleMp4) },
    );
    await request(app.getHttpServer())
      .post(`/videos/${videoId}/uploads/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [{ partNumber: 1, etag: putRes.headers.get('etag') }] })
      .expect(202);

    const settled = await pollVideoUntilSettled(accessToken, videoId);
    expect(settled.status).toBe(VideoStatus.READY);
    const row = await videoRepo.findOneByOrFail({ id: videoId });
    if (row.thumbnail_key) createdStorageKeys.push(row.thumbnail_key);
    return { shortCode };
  }

  it('downloads files whose name is outside Latin-1 and answers HEAD without reading storage', async () => {
    const { accessToken } = await registerConfirmAndLogin('filename');
    const { shortCode } = await uploadReadyVideo(
      accessToken,
      'Aula 01 – Introdução.mp4',
    );

    const downloadRes = await request(app.getHttpServer())
      .get(`/videos/${shortCode}/download`)
      .buffer(true)
      .parse((res, cb) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => cb(null, Buffer.concat(chunks)));
      })
      .expect(200);
    expect(downloadRes.headers['content-disposition']).toBe(
      `attachment; filename="Aula 01 _ Introducao.mp4"; filename*=UTF-8''Aula%2001%20%E2%80%93%20Introdu%C3%A7%C3%A3o.mp4`,
    );
    expect(Buffer.compare(downloadRes.body as Buffer, sampleMp4)).toBe(0);

    const getObject = jest.spyOn(storageService, 'getObjectStream');
    try {
      for (const route of ['stream', 'download']) {
        const headRes = await request(app.getHttpServer())
          .head(`/videos/${shortCode}/${route}`)
          .expect(200);
        expect(headRes.headers['content-length']).toBe(
          String(sampleMp4.length),
        );
      }
      const rangedHead = await request(app.getHttpServer())
        .head(`/videos/${shortCode}/stream`)
        .set('Range', 'bytes=0-99')
        .expect(206);
      expect(rangedHead.headers['content-range']).toBe(
        `bytes 0-99/${sampleMp4.length}`,
      );
      expect(getObject).not.toHaveBeenCalled();
    } finally {
      getObject.mockRestore();
    }
  }, 30000);

  it('generates distinct unique shortCodes for multiple videos', async () => {
    const { accessToken } = await registerConfirmAndLogin('multi');

    const res1 = await request(app.getHttpServer())
      .post('/videos/uploads/initiate')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Same Title',
        filename: 'a.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1024,
      })
      .expect(201);

    const res2 = await request(app.getHttpServer())
      .post('/videos/uploads/initiate')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Same Title',
        filename: 'a.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1024,
      })
      .expect(201);

    expect((res1.body as InitiateUploadResponseDto).shortCode).not.toBe(
      (res2.body as InitiateUploadResponseDto).shortCode,
    );
  });

  it('enforces auth, size/MIME limits, validation, ownership, and abort cleanup', async () => {
    // Unauthenticated initiate -> 401
    await request(app.getHttpServer())
      .post('/videos/uploads/initiate')
      .send({
        title: 'No Auth',
        filename: 'a.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1024,
      })
      .expect(401);

    const owner = await registerConfirmAndLogin('owner');
    const otherUser = await registerConfirmAndLogin('other');

    // DTO ValidationPipe wiring -> 400 VALIDATION_ERROR
    const badBody = await request(app.getHttpServer())
      .post('/videos/uploads/initiate')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: '',
        filename: 'a.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1024,
        unexpectedField: true,
      })
      .expect(400);
    expect((badBody.body as ErrorBody).error).toBe('VALIDATION_ERROR');

    // > 10 GiB -> 413 UPLOAD_LIMIT_EXCEEDED
    const tooLarge = await request(app.getHttpServer())
      .post('/videos/uploads/initiate')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: 'Too Big',
        filename: 'big.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 10 * 1024 * 1024 * 1024 + 1,
      })
      .expect(413);
    expect((tooLarge.body as ErrorBody).error).toBe('UPLOAD_LIMIT_EXCEEDED');

    // Unsupported MIME -> 415 UNSUPPORTED_MEDIA_TYPE
    const badMime = await request(app.getHttpServer())
      .post('/videos/uploads/initiate')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: 'Bad Mime',
        filename: 'doc.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
      })
      .expect(415);
    expect((badMime.body as ErrorBody).error).toBe('UNSUPPORTED_MEDIA_TYPE');

    // Initiate draft for ownership & abort checks
    const initRes = await request(app.getHttpServer())
      .post('/videos/uploads/initiate')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        title: 'Owned Draft',
        filename: 'owned.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1024,
      })
      .expect(201);
    const draftId = (initRes.body as InitiateUploadResponseDto).videoId;

    // Cross-user access -> 403 VIDEO_ACCESS_DENIED
    const forbidden = await request(app.getHttpServer())
      .post(`/videos/${draftId}/uploads/parts`)
      .set('Authorization', `Bearer ${otherUser.accessToken}`)
      .send({ partNumber: 1 })
      .expect(403);
    expect((forbidden.body as ErrorBody).error).toBe('VIDEO_ACCESS_DENIED');

    await request(app.getHttpServer())
      .get(`/videos/${draftId}/status`)
      .set('Authorization', `Bearer ${otherUser.accessToken}`)
      .expect(403);

    // Abort draft -> 204 and row deleted
    await request(app.getHttpServer())
      .post(`/videos/${draftId}/uploads/abort`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(204);

    const row = await videoRepo.findOneBy({ id: draftId });
    expect(row).toBeNull();
  });

  it('transitions corrupt video uploads to failed after worker retries exhaust', async () => {
    const { accessToken } = await registerConfirmAndLogin('corrupt');
    const corruptBytes = Buffer.from('not-a-valid-mp4-container-at-all');

    const initRes = await request(app.getHttpServer())
      .post('/videos/uploads/initiate')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({
        title: 'Corrupt Video',
        filename: 'corrupt.mp4',
        mimeType: 'video/mp4',
        sizeBytes: corruptBytes.length,
      })
      .expect(201);

    const { videoId, storageKey } = initRes.body as InitiateUploadResponseDto;
    createdStorageKeys.push(storageKey);

    const partRes = await request(app.getHttpServer())
      .post(`/videos/${videoId}/uploads/parts`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ partNumber: 1 })
      .expect(200);

    const putRes = await fetch(
      (partRes.body as SignUploadPartResponseDto).presignedUrl,
      {
        method: 'PUT',
        body: new Uint8Array(corruptBytes),
      },
    );
    const etag = putRes.headers.get('etag');

    await request(app.getHttpServer())
      .post(`/videos/${videoId}/uploads/complete`)
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ parts: [{ partNumber: 1, etag }] })
      .expect(202);

    const settled = await pollVideoUntilSettled(accessToken, videoId, 25000);
    expect(settled.status).toBe(VideoStatus.FAILED);
    expect(settled.processingError).toMatch(/^ffprobe failed: /);
    expect(settled.processingError).not.toMatch(/X-Amz|minio:9000|https?:\/\//);
  }, 30000);
});
