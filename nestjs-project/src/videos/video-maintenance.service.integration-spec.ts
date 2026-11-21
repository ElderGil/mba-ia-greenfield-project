import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
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
import { VideoInvalidStateException } from '../common/exceptions/domain.exception';
import { Video, VideoStatus } from './entities/video.entity';
import { VideoMaintenanceService } from './video-maintenance.service';
import {
  VIDEO_PROCESSING_QUEUE,
  type VideoProcessingJobData,
} from './videos-queue.constants';
import { VideosQueueService } from './videos-queue.service';
import { VideosUploadService } from './videos-upload.service';

describe('VideoMaintenanceService (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let maintenance: VideoMaintenanceService;
  let uploadService: VideosUploadService;
  let storageService: S3StorageService;
  let channelsService: ChannelsService;
  let userRepo: Repository<User>;
  let videoRepo: Repository<Video>;
  let queue: Queue<VideoProcessingJobData>;
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
      providers: [
        VideosQueueService,
        VideosUploadService,
        VideoMaintenanceService,
      ],
    }).compile();

    await moduleRef.init();
    dataSource = moduleRef.get(DataSource);
    maintenance = moduleRef.get(VideoMaintenanceService);
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
    await queue.obliterate({ force: true });
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    await queue.obliterate({ force: true });
  });

  afterEach(async () => {
    await multipartUploads.abortRemaining(storageService);
  });

  let counter = 0;
  async function createOwnerId(): Promise<string> {
    const user = await userRepo.save(
      userRepo.create({
        email: `maintenance_${++counter}@example.com`,
        password: 'hash',
        is_confirmed: true,
      }),
    );
    await channelsService.createChannel(user.id, user.email);
    return user.id;
  }

  async function initiate(userId: string) {
    const upload = await uploadService.initiateUpload(userId, {
      title: 'Clip',
      filename: 'clip.mp4',
      mimeType: 'video/mp4',
      sizeBytes: 1024,
    });
    return multipartUploads.track(upload);
  }

  async function age(
    videoId: string,
    column: 'created_at' | 'updated_at',
    interval: string,
  ): Promise<void> {
    await dataSource.query(
      `UPDATE videos SET ${column} = now() - $2::interval WHERE id = $1`,
      [videoId, interval],
    );
  }

  it('aborts the multipart upload and deletes drafts older than the TTL, keeping fresh ones', async () => {
    const userId = await createOwnerId();
    const stale = await initiate(userId);
    const fresh = await initiate(userId);
    await age(stale.videoId, 'created_at', '25 hours');

    const result = await maintenance.sweep(new Date());

    expect(result.abortedDrafts).toBe(1);
    expect(await videoRepo.findOneBy({ id: stale.videoId })).toBeNull();
    expect(await videoRepo.findOneBy({ id: fresh.videoId })).not.toBeNull();

    // The stale multipart upload no longer accepts parts.
    const url = await storageService.getPresignedPartUrl(
      stale.storageKey,
      stale.uploadId,
      1,
      60,
    );
    const put = await fetch(url, { method: 'PUT', body: 'x' });
    expect(put.status).toBe(404);
  });

  it('fails processing videos stuck past the threshold without a live job and leaves the rest alone', async () => {
    const userId = await createOwnerId();
    const orphan = await initiate(userId);
    const queued = await initiate(userId);
    const recent = await initiate(userId);
    for (const v of [orphan, queued, recent]) {
      await videoRepo.update(
        { id: v.videoId },
        { status: VideoStatus.PROCESSING },
      );
      await storageService.abortMultipartUpload(v.storageKey, v.uploadId);
    }
    await age(orphan.videoId, 'updated_at', '31 minutes');
    await age(queued.videoId, 'updated_at', '31 minutes');
    // A backlog: the job exists and is still waiting for a worker.
    await queue.add(
      'process-video',
      { videoId: queued.videoId },
      { jobId: `process-video-${queued.videoId}` },
    );

    const result = await maintenance.sweep(new Date());

    expect(result.failedOrphans).toBe(1);
    const orphanRow = await videoRepo.findOneByOrFail({ id: orphan.videoId });
    expect(orphanRow.status).toBe(VideoStatus.FAILED);
    expect(orphanRow.processing_error).toMatch(/processing job was lost/i);
    expect(
      (await videoRepo.findOneByOrFail({ id: queued.videoId })).status,
    ).toBe(VideoStatus.PROCESSING);
    expect(
      (await videoRepo.findOneByOrFail({ id: recent.videoId })).status,
    ).toBe(VideoStatus.PROCESSING);
  });

  it('deletes a stale draft whose multipart upload is already gone (NoSuchUpload)', async () => {
    const userId = await createOwnerId();
    const stale = await initiate(userId);
    await age(stale.videoId, 'created_at', '25 hours');
    await storageService.abortMultipartUpload(stale.storageKey, stale.uploadId);

    const result = await maintenance.sweep(new Date());

    expect(result.abortedDrafts).toBe(1);
    expect(await videoRepo.findOneBy({ id: stale.videoId })).toBeNull();
  });

  it('keeps sweeping the other drafts when one multipart abort fails', async () => {
    const userId = await createOwnerId();
    const broken = await initiate(userId);
    const stale = await initiate(userId);
    await age(broken.videoId, 'created_at', '25 hours');
    await age(stale.videoId, 'created_at', '26 hours');
    jest
      .spyOn(storageService, 'abortMultipartUpload')
      .mockImplementation((key: string) =>
        key === broken.storageKey
          ? Promise.reject(new Error('storage unavailable'))
          : Promise.resolve(),
      );

    try {
      const result = await maintenance.sweep(new Date());

      expect(result.abortedDrafts).toBe(1);
      expect(await videoRepo.findOneBy({ id: stale.videoId })).toBeNull();
      // Kept for the next sweep instead of losing track of the upload.
      const kept = await videoRepo.findOneByOrFail({ id: broken.videoId });
      expect(kept.status).toBe(VideoStatus.DRAFT);
      expect(kept.upload_id).toBe(broken.uploadId);
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('lets a stale-draft sweep that started first win over a concurrent complete', async () => {
    const userId = await createOwnerId();
    const stale = await initiate(userId);
    await age(stale.videoId, 'created_at', '25 hours');
    const sweepAtStorage = deferred();
    const releaseSweep = deferred();
    const completeAtStorage = deferred();
    const sweepDone = deferred();
    // Each spy pauses its call once, then restores and runs the real one.
    const abortSpy = jest.spyOn(storageService, 'abortMultipartUpload');
    abortSpy.mockImplementationOnce(async (key, uploadId) => {
      sweepAtStorage.resolve();
      await releaseSweep.promise;
      abortSpy.mockRestore();
      return storageService.abortMultipartUpload(key, uploadId);
    });
    const completeSpy = jest.spyOn(storageService, 'completeMultipartUpload');
    completeSpy.mockImplementationOnce(async (key, uploadId, parts) => {
      completeAtStorage.resolve();
      await sweepDone.promise;
      completeSpy.mockRestore();
      return storageService.completeMultipartUpload(key, uploadId, parts);
    });

    try {
      const sweep = maintenance.sweep(new Date());
      void settled(sweep).then(sweepDone.resolve);
      await sweepAtStorage.promise;
      const complete = uploadService.completeUpload(userId, stale.videoId, [
        { partNumber: 1, etag: '"etag"' },
      ]);
      await Promise.race([completeAtStorage.promise, settled(complete)]);
      releaseSweep.resolve();
      const [sweepResult, completeResult] = await Promise.allSettled([
        sweep,
        complete,
      ]);

      expect(sweepResult).toEqual({
        status: 'fulfilled',
        value: { abortedDrafts: 1, failedOrphans: 0 },
      });
      expect(completeResult.status).toBe('rejected');
      expect((completeResult as PromiseRejectedResult).reason).toBeInstanceOf(
        VideoInvalidStateException,
      );
      expect(await videoRepo.findOneBy({ id: stale.videoId })).toBeNull();
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('reaches drafts beyond a full batch of drafts it cannot remove', async () => {
    const userId = await createOwnerId();
    const channel = await channelsService.findByUserId(userId);
    // 100 stale drafts (a whole batch) whose abort keeps failing, all older
    // than one removable draft.
    const stuck = Array.from({ length: 100 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      upload_id: `stuck-${i}`,
      storage_key: `videos/stuck/${i}/original.mp4`,
      short_code: `Stuck${String(i).padStart(6, '0')}`,
    }));
    const removable = {
      id: 'ffffffff-ffff-4fff-bfff-ffffffffffff',
      upload_id: null,
      storage_key: null,
      short_code: 'Removable01',
    };
    await videoRepo.insert(
      [...stuck, removable].map((row) => ({
        ...row,
        channel_id: channel!.id,
        title: 'Stale',
        original_filename: 'stale.mp4',
        status: VideoStatus.DRAFT,
        mime_type: 'video/mp4',
        size_bytes: '1024',
      })),
    );
    await dataSource.query(
      `UPDATE videos SET created_at = now() - interval '26 hours' WHERE upload_id IS NOT NULL`,
    );
    await age(removable.id, 'created_at', '25 hours');
    jest
      .spyOn(storageService, 'abortMultipartUpload')
      .mockRejectedValue(new Error('storage unavailable'));

    try {
      const result = await maintenance.sweep(new Date());

      expect(result.abortedDrafts).toBe(1);
      expect(await videoRepo.findOneBy({ id: removable.id })).toBeNull();
      expect(await videoRepo.count()).toBe(100);
    } finally {
      jest.restoreAllMocks();
    }
  });
});
