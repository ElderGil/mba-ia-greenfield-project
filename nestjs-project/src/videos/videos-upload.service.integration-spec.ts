import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { UploadLimitExceededException } from '../common/exceptions/domain.exception';
import {
  InvalidUploadPartsException,
  VideoInvalidStateException,
} from '../common/exceptions/domain.exception';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import queueConfig, { bullRootOptions } from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { S3StorageService } from '../storage/s3-storage.service';
import { StorageModule } from '../storage/storage.module';
import { cleanAllTables } from '../test/create-test-data-source';
import { deferred, settled } from '../test/deferred';
import { ALL_ENTITIES } from '../test/test-entities';
import { TestMultipartUploads } from '../test/test-multipart-uploads';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import {
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from './videos-queue.constants';
import { VideosQueueService } from './videos-queue.service';
import { VideosUploadService } from './videos-upload.service';

describe('VideosUploadService (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let uploadService: VideosUploadService;
  let storageService: S3StorageService;
  let channelsService: ChannelsService;
  let userRepo: Repository<User>;
  let videoRepo: Repository<Video>;
  let queue: Queue<VideoProcessingJobData>;
  const createdKeys: string[] = [];
  const multipartUploads = new TestMultipartUploads();

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig, queueConfig, videoConfig],
        }),
        TypeOrmModule.forRootAsync({
          inject: [databaseConfig.KEY],
          useFactory: (dbCfg: ConfigType<typeof databaseConfig>) => ({
            type: 'postgres',
            host: dbCfg.host,
            port: dbCfg.port,
            username: dbCfg.username,
            password: dbCfg.password,
            database: dbCfg.name,
            entities: ALL_ENTITIES,
          }),
        }),
        TypeOrmModule.forFeature([Video]),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (qCfg: ConfigType<typeof queueConfig>) =>
            bullRootOptions(qCfg),
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
        ChannelsModule,
        StorageModule,
      ],
      providers: [VideosQueueService, VideosUploadService],
    }).compile();

    await moduleRef.init();
    dataSource = moduleRef.get(DataSource);
    uploadService = moduleRef.get(VideosUploadService);
    storageService = moduleRef.get(S3StorageService);
    channelsService = moduleRef.get(ChannelsService);
    userRepo = dataSource.getRepository(User);
    videoRepo = moduleRef.get<Repository<Video>>(getRepositoryToken(Video));
    queue = moduleRef.get<Queue<VideoProcessingJobData>>(
      getQueueToken(VIDEO_PROCESSING_QUEUE),
    );
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await storageService.deleteObject(key).catch(() => undefined);
    }
    await queue.obliterate({ force: true });
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  let counter = 0;
  afterEach(async () => {
    jest.restoreAllMocks();
    await multipartUploads.abortRemaining(storageService);
  });

  async function createOwner(): Promise<{ user: User; channel: Channel }> {
    const idx = ++counter;
    const user = await userRepo.save(
      userRepo.create({
        email: `uploader_${idx}@example.com`,
        password: 'hash',
        is_confirmed: true,
      }),
    );
    const channel = await channelsService.createChannel(user.id, user.email);
    return { user, channel };
  }

  it('initiates draft, signs presigned part, completes upload in MinIO, transitions to processing, and enqueues BullMQ job', async () => {
    const { user } = await createOwner();
    const payload = Buffer.from('real-video-bytes-for-integration-test');

    const init = await uploadService.initiateUpload(user.id, {
      title: 'Integration Clip',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: payload.length,
    });
    multipartUploads.track(init);
    createdKeys.push(init.storageKey);

    expect(init.status).toBe(VideoStatus.DRAFT);
    expect(init.shortCode).toMatch(/^[A-Za-z0-9_-]{11}$/);

    const draftRow = await videoRepo.findOneByOrFail({ id: init.videoId });
    expect(draftRow.status).toBe(VideoStatus.DRAFT);
    expect(draftRow.upload_id).toBe(init.uploadId);

    const signed = await uploadService.signUploadPart(user.id, init.videoId, 1);
    const putRes = await fetch(signed.presignedUrl, {
      method: 'PUT',
      body: payload,
    });
    expect(putRes.ok).toBe(true);
    const etag = putRes.headers.get('etag');
    expect(etag).toBeTruthy();

    const completed = await uploadService.completeUpload(
      user.id,
      init.videoId,
      [{ partNumber: 1, etag: etag! }],
    );

    expect(completed.status).toBe(VideoStatus.PROCESSING);
    const updatedRow = await videoRepo.findOneByOrFail({ id: init.videoId });
    expect(updatedRow.status).toBe(VideoStatus.PROCESSING);
    expect(updatedRow.upload_id).toBeNull();
    expect(Number(updatedRow.size_bytes)).toBe(payload.length);

    const job = await queue.getJob(completed.jobId);
    expect(job).toBeDefined();
    expect(job!.data.videoId).toBe(init.videoId);
    expect(job!.data).toEqual({ videoId: init.videoId });
  });

  async function initiateAndUploadParts(
    userId: string,
    parts: Buffer[],
  ): Promise<{
    videoId: string;
    uploaded: { partNumber: number; etag: string }[];
  }> {
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const init = await uploadService.initiateUpload(userId, {
      title: 'Multipart Clip',
      filename: 'multi.mp4',
      mimeType: 'video/mp4',
      sizeBytes: total,
    });
    multipartUploads.track(init);
    createdKeys.push(init.storageKey);
    const uploaded: { partNumber: number; etag: string }[] = [];
    for (const [i, body] of parts.entries()) {
      const signed = await uploadService.signUploadPart(
        userId,
        init.videoId,
        i + 1,
      );
      const putRes = await fetch(signed.presignedUrl, {
        method: 'PUT',
        body: new Uint8Array(body),
      });
      expect(putRes.ok).toBe(true);
      uploaded.push({ partNumber: i + 1, etag: putRes.headers.get('etag')! });
    }
    return { videoId: init.videoId, uploaded };
  }

  it('assembles a multi-part upload whose parts are listed out of order', async () => {
    const { user } = await createOwner();
    const first = Buffer.alloc(5 * 1024 * 1024, 0x61); // S3 minimum for non-last parts
    const tail = Buffer.alloc(1024 * 1024, 0x62);
    const { videoId, uploaded } = await initiateAndUploadParts(user.id, [
      first,
      tail,
    ]);

    await uploadService.completeUpload(
      user.id,
      videoId,
      [...uploaded].reverse(),
    );

    const row = await videoRepo.findOneByOrFail({ id: videoId });
    expect(row.status).toBe(VideoStatus.PROCESSING);
    expect(Number(row.size_bytes)).toBe(first.length + tail.length);
    const range = await storageService.getObjectStream(
      row.storage_key!,
      `bytes=${first.length - 1}-${first.length}`,
    );
    const boundary: Buffer[] = [];
    for await (const chunk of range.stream) boundary.push(chunk as Buffer);
    expect(Buffer.concat(boundary).toString()).toBe('ab');
  });

  it('rejects a non-last part below the S3 minimum and keeps the draft retryable', async () => {
    const { user } = await createOwner();
    const { videoId, uploaded } = await initiateAndUploadParts(user.id, [
      Buffer.alloc(1024, 0x61),
      Buffer.alloc(1024, 0x62),
    ]);

    await expect(
      uploadService.completeUpload(user.id, videoId, uploaded),
    ).rejects.toThrow(InvalidUploadPartsException);

    const row = await videoRepo.findOneByOrFail({ id: videoId });
    expect(row.status).toBe(VideoStatus.DRAFT);
    expect(row.upload_id).not.toBeNull();
  });

  async function initiateAndUploadOnePart(
    userId: string,
  ): Promise<{ videoId: string; etag: string }> {
    const payload = Buffer.from('real-video-bytes-for-integration-test');
    const init = await uploadService.initiateUpload(userId, {
      title: 'Integration Clip',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: payload.length,
    });
    multipartUploads.track(init);
    createdKeys.push(init.storageKey);
    const signed = await uploadService.signUploadPart(userId, init.videoId, 1);
    const putRes = await fetch(signed.presignedUrl, {
      method: 'PUT',
      body: payload,
    });
    return { videoId: init.videoId, etag: putRes.headers.get('etag')! };
  }

  it('marks the video failed in the database when the processing job cannot be enqueued', async () => {
    const { user } = await createOwner();
    const { videoId, etag } = await initiateAndUploadOnePart(user.id);
    jest
      .spyOn(moduleRef.get(VideosQueueService), 'enqueueProcessVideo')
      .mockRejectedValueOnce(new Error('Redis connection refused'));

    await expect(
      uploadService.completeUpload(user.id, videoId, [{ partNumber: 1, etag }]),
    ).rejects.toThrow('Redis connection refused');

    const row = await videoRepo.findOneByOrFail({ id: videoId });
    expect(row.status).toBe(VideoStatus.FAILED);
    expect(row.processing_error).toContain('Redis connection refused');
  });

  it('marks the video failed in the database when the completed object cannot be inspected', async () => {
    const { user } = await createOwner();
    const { videoId, etag } = await initiateAndUploadOnePart(user.id);
    jest
      .spyOn(moduleRef.get(S3StorageService), 'headObject')
      .mockRejectedValueOnce(new Error('socket hang up'));
    const enqueue = jest.spyOn(
      moduleRef.get(VideosQueueService),
      'enqueueProcessVideo',
    );

    await expect(
      uploadService.completeUpload(user.id, videoId, [{ partNumber: 1, etag }]),
    ).rejects.toThrow('socket hang up');

    const row = await videoRepo.findOneByOrFail({ id: videoId });
    expect(row.status).toBe(VideoStatus.FAILED);
    expect(row.upload_id).toBeNull();
    expect(row.processing_error).toContain('socket hang up');
    expect(enqueue).not.toHaveBeenCalledWith(
      expect.objectContaining({ videoId }),
    );
  });

  it('lets exactly one of two concurrent completes win and rejects the other with VideoInvalidStateException', async () => {
    const { user } = await createOwner();
    const { videoId, etag } = await initiateAndUploadOnePart(user.id);
    const parts = [{ partNumber: 1, etag }];

    const results = await Promise.allSettled([
      uploadService.completeUpload(user.id, videoId, parts),
      uploadService.completeUpload(user.id, videoId, parts),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(VideoInvalidStateException);
    const row = await videoRepo.findOneByOrFail({ id: videoId });
    expect(row.status).toBe(VideoStatus.PROCESSING);
  });

  it('aborts an active draft upload and removes the draft row', async () => {
    const { user } = await createOwner();

    const init = await uploadService.initiateUpload(user.id, {
      title: 'Aborted Clip',
      filename: 'abort.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1024,
    });

    multipartUploads.track(init);
    await uploadService.abortUpload(user.id, init.videoId);

    const gone = await videoRepo.findOneBy({ id: init.videoId });
    expect(gone).toBeNull();
  });

  it('aborts the multipart upload and removes the draft when the draft cannot record it', async () => {
    const { user } = await createOwner();
    let created: { key: string; uploadId: string } | undefined;
    const createSpy = jest.spyOn(storageService, 'createMultipartUpload');
    createSpy.mockImplementationOnce(async (key, contentType) => {
      createSpy.mockRestore();
      const uploadId = await storageService.createMultipartUpload(
        key,
        contentType,
      );
      created = { key, uploadId };
      multipartUploads.track({ storageKey: key, uploadId });
      return uploadId;
    });
    // First save creates the draft; the one recording the upload fails.
    const saveSpy = jest.spyOn(videoRepo, 'save');
    saveSpy.mockImplementationOnce(async (entity) => {
      saveSpy.mockImplementationOnce(() =>
        Promise.reject(new Error('db down')),
      );
      return videoRepo.manager.save(Video, entity as Video);
    });

    try {
      await expect(
        uploadService.initiateUpload(user.id, {
          title: 'Unrecorded',
          filename: 'unrecorded.mp4',
          mimeType: 'video/mp4',
          sizeBytes: 1024,
        }),
      ).rejects.toThrow('db down');
    } finally {
      saveSpy.mockRestore();
    }

    expect(created).toBeDefined();
    await expect(
      storageService.listUploadedParts(created!.key, created!.uploadId),
    ).rejects.toMatchObject({ name: 'NoSuchUpload' });
    expect(await videoRepo.count()).toBe(0);
  });

  it('rejects parts above the size limit before storage assembles them, and aborts the upload', async () => {
    const { user } = await createOwner();
    const config = moduleRef.get<ConfigType<typeof videoConfig>>(
      videoConfig.KEY,
    );
    const originalMax = config.maxFileSizeBytes;
    config.maxFileSizeBytes = 1024;
    const completeSpy = jest.spyOn(storageService, 'completeMultipartUpload');
    try {
      // Declared within the limit; the presigned PUT cannot enforce it.
      const init = await uploadService.initiateUpload(user.id, {
        title: 'Too big',
        filename: 'big.mp4',
        mimeType: 'video/mp4',
        sizeBytes: 1000,
      });
      multipartUploads.track(init);
      createdKeys.push(init.storageKey);
      const signed = await uploadService.signUploadPart(
        user.id,
        init.videoId,
        1,
      );
      const put = await fetch(signed.presignedUrl, {
        method: 'PUT',
        body: new Uint8Array(4096),
      });
      expect(put.ok).toBe(true);

      await expect(
        uploadService.completeUpload(user.id, init.videoId, [
          { partNumber: 1, etag: put.headers.get('etag')! },
        ]),
      ).rejects.toBeInstanceOf(UploadLimitExceededException);

      expect(completeSpy).not.toHaveBeenCalled();
      await expect(
        storageService.listUploadedParts(init.storageKey, init.uploadId),
      ).rejects.toMatchObject({ name: 'NoSuchUpload' });
      const row = await videoRepo.findOneByOrFail({ id: init.videoId });
      expect(row.status).toBe(VideoStatus.FAILED);
      expect(row.upload_id).toBeNull();
    } finally {
      config.maxFileSizeBytes = originalMax;
      completeSpy.mockRestore();
    }
  });

  describe('races and ambiguous storage outcomes', () => {
    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('lets an abort that started first win over a concurrent complete, leaving no dead draft', async () => {
      const { user } = await createOwner();
      const { videoId, etag } = await initiateAndUploadOnePart(user.id);
      const abortAtStorage = deferred();
      const releaseAbort = deferred();
      const completeAtStorage = deferred();
      const abortDone = deferred();
      // Each spy pauses its call once, then restores and runs the real one.
      const abortSpy = jest.spyOn(storageService, 'abortMultipartUpload');
      abortSpy.mockImplementationOnce(async (key, uploadId) => {
        abortAtStorage.resolve();
        await releaseAbort.promise;
        abortSpy.mockRestore();
        return storageService.abortMultipartUpload(key, uploadId);
      });
      const completeSpy = jest.spyOn(storageService, 'completeMultipartUpload');
      completeSpy.mockImplementationOnce(async (key, uploadId, parts) => {
        completeAtStorage.resolve();
        await abortDone.promise;
        completeSpy.mockRestore();
        return storageService.completeMultipartUpload(key, uploadId, parts);
      });

      // The abort reaches storage first; the complete runs while it waits.
      const abort = uploadService.abortUpload(user.id, videoId);
      void settled(abort).then(abortDone.resolve);
      await abortAtStorage.promise;
      const complete = uploadService.completeUpload(user.id, videoId, [
        { partNumber: 1, etag },
      ]);
      await Promise.race([completeAtStorage.promise, settled(complete)]);
      releaseAbort.resolve();
      const [abortResult, completeResult] = await Promise.allSettled([
        abort,
        complete,
      ]);

      expect(abortResult.status).toBe('fulfilled');
      expect(completeResult.status).toBe('rejected');
      expect((completeResult as PromiseRejectedResult).reason).toBeInstanceOf(
        VideoInvalidStateException,
      );
      expect(await videoRepo.findOneBy({ id: videoId })).toBeNull();
    });

    it('finishes the upload when an earlier complete closed it but its response was lost', async () => {
      const { user } = await createOwner();
      const { videoId, etag } = await initiateAndUploadOnePart(user.id);
      const parts = [{ partNumber: 1, etag }];
      // Storage completes the upload, then the response is lost.
      const completeSpy = jest.spyOn(storageService, 'completeMultipartUpload');
      completeSpy.mockImplementationOnce(async (key, uploadId, p) => {
        completeSpy.mockRestore();
        await storageService.completeMultipartUpload(key, uploadId, p);
        throw new Error('socket hang up');
      });

      await expect(
        uploadService.completeUpload(user.id, videoId, parts),
      ).rejects.toThrow('socket hang up');
      // Unknown outcome: the draft stays retryable.
      expect((await videoRepo.findOneByOrFail({ id: videoId })).status).toBe(
        VideoStatus.DRAFT,
      );

      const retried = await uploadService.completeUpload(
        user.id,
        videoId,
        parts,
      );

      expect(retried.status).toBe(VideoStatus.PROCESSING);
      const row = await videoRepo.findOneByOrFail({ id: videoId });
      expect(row.status).toBe(VideoStatus.PROCESSING);
      expect(row.upload_id).toBeNull();
      expect(await queue.getJob(retried.jobId)).toBeDefined();
    });

    it('marks the video failed when the multipart upload is gone and no object was stored', async () => {
      const { user } = await createOwner();
      const { videoId, etag } = await initiateAndUploadOnePart(user.id);
      const draft = await videoRepo.findOneByOrFail({ id: videoId });
      // Expired or aborted outside the API (e.g. a bucket lifecycle rule).
      await realAbortOf(draft);

      await expect(
        uploadService.completeUpload(user.id, videoId, [
          { partNumber: 1, etag },
        ]),
      ).rejects.toBeInstanceOf(VideoInvalidStateException);

      const row = await videoRepo.findOneByOrFail({ id: videoId });
      expect(row.status).toBe(VideoStatus.FAILED);
      expect(row.upload_id).toBeNull();
      expect(row.processing_error).toMatch(/no longer exists/i);
    });

    async function realAbortOf(video: Video): Promise<void> {
      await storageService.abortMultipartUpload(
        video.storage_key!,
        video.upload_id!,
      );
    }
  });
});
