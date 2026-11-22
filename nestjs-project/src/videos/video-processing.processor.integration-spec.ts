import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { DataSource, Repository } from 'typeorm';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import { S3StorageService } from '../storage/s3-storage.service';
import { StorageModule } from '../storage/storage.module';
import { cleanAllTables } from '../test/create-test-data-source';
import { ALL_ENTITIES } from '../test/test-entities';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { MediaProcessorService } from './media-processor.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import type { VideoProcessingJobData } from './videos-queue.constants';

const execFileAsync = promisify(execFile);

describe('VideoProcessingProcessor (integration with MinIO + FFmpeg + Postgres)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let processor: VideoProcessingProcessor;
  let storageService: S3StorageService;
  let channelsService: ChannelsService;
  let userRepo: Repository<User>;
  let videoRepo: Repository<Video>;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [databaseConfig, storageConfig],
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
        ChannelsModule,
        StorageModule,
      ],
      providers: [MediaProcessorService, VideoProcessingProcessor],
    }).compile();

    await moduleRef.init();
    dataSource = moduleRef.get(DataSource);
    processor = moduleRef.get(VideoProcessingProcessor);
    storageService = moduleRef.get(S3StorageService);
    channelsService = moduleRef.get(ChannelsService);
    userRepo = dataSource.getRepository(User);
    videoRepo = moduleRef.get<Repository<Video>>(getRepositoryToken(Video));
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await storageService.deleteObject(key).catch(() => undefined);
    }
    await moduleRef.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  it('extracts metadata + thumbnail from MP4 in MinIO and marks DB video ready', async () => {
    const user = await userRepo.save(
      userRepo.create({
        email: 'worker_int@example.com',
        password: 'hash',
        is_confirmed: true,
      }),
    );
    const channel = await channelsService.createChannel(user.id, user.email);

    const tmpMp4 = path.join(os.tmpdir(), `proc-${randomUUID()}.mp4`);
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
    const mp4Bytes = await fs.readFile(tmpMp4);
    await fs.unlink(tmpMp4).catch(() => undefined);

    const video = await videoRepo.save(
      videoRepo.create({
        channel_id: channel.id,
        short_code: 'ProcTest123',
        title: 'Worker Test',
        original_filename: 'worker.mp4',
        status: VideoStatus.PROCESSING,
        mime_type: 'video/mp4',
        size_bytes: String(mp4Bytes.length),
      }),
    );

    const storageKey = `videos/${channel.id}/${video.id}/original.mp4`;
    const thumbKey = `thumbnails/${channel.id}/${video.id}/thumb.jpg`;
    createdKeys.push(storageKey, thumbKey);

    await storageService.putObject(storageKey, mp4Bytes, 'video/mp4');
    await videoRepo.update({ id: video.id }, { storage_key: storageKey });

    const job = {
      id: `process-video-${video.id}`,
      data: {
        videoId: video.id,
        channelId: channel.id,
        storageKey,
        mimeType: 'video/mp4',
      },
      attemptsMade: 1,
      opts: { attempts: 3 },
    } as unknown as Job<VideoProcessingJobData>;

    await processor.process(job);

    const updated = await videoRepo.findOneByOrFail({ id: video.id });
    expect(updated.status).toBe(VideoStatus.READY);
    expect(updated.thumbnail_key).toBe(thumbKey);
    expect(updated.duration_seconds).toBeGreaterThanOrEqual(1.3);
    expect(updated.width).toBe(320);
    expect(updated.height).toBe(240);
    expect(updated.codec).toBe('h264');
    expect(updated.processing_error).toBeNull();

    const thumbHead = await storageService.headObject(thumbKey);
    expect(thumbHead.contentLength).toBeGreaterThan(100);
    expect(thumbHead.contentType).toBe('image/jpeg');
  });

  describe('job and row state', () => {
    let sampleMp4: Buffer;
    let counter = 0;

    beforeAll(async () => {
      const tmp = path.join(os.tmpdir(), `proc-state-${randomUUID()}.mp4`);
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
        tmp,
      ]);
      sampleMp4 = await fs.readFile(tmp);
      await fs.unlink(tmp).catch(() => undefined);
    });

    async function storedVideo(status: VideoStatus): Promise<{
      video: Video;
      thumbKey: string;
    }> {
      const user = await userRepo.save(
        userRepo.create({
          email: `worker_state_${++counter}@example.com`,
          password: 'hash',
          is_confirmed: true,
        }),
      );
      const channel = await channelsService.createChannel(user.id, user.email);
      const video = await videoRepo.save(
        videoRepo.create({
          channel_id: channel.id,
          short_code: `State${String(counter).padStart(6, '0')}`,
          title: 'State Test',
          original_filename: 'state.mp4',
          status,
          mime_type: 'video/mp4',
          size_bytes: String(sampleMp4.length),
        }),
      );
      const storageKey = `videos/${channel.id}/${video.id}/original.mp4`;
      const thumbKey = `thumbnails/${channel.id}/${video.id}/thumb.jpg`;
      createdKeys.push(storageKey, thumbKey);
      await storageService.putObject(storageKey, sampleMp4, 'video/mp4');
      await videoRepo.update({ id: video.id }, { storage_key: storageKey });
      return {
        video: await videoRepo.findOneByOrFail({ id: video.id }),
        thumbKey,
      };
    }

    // Older jobs also carried these; they must be ignored.
    type LegacyJobData = VideoProcessingJobData & {
      channelId?: string;
      storageKey?: string;
      mimeType?: string;
    };

    function jobFor(
      data: LegacyJobData,
      attemptsMade = 1,
    ): Job<VideoProcessingJobData> {
      return {
        id: `process-video-${data.videoId}`,
        data,
        attemptsMade,
        opts: { attempts: 3 },
      } as unknown as Job<VideoProcessingJobData>;
    }

    it('reads the storage key and channel from the row, not from the job payload', async () => {
      const { video, thumbKey } = await storedVideo(VideoStatus.PROCESSING);

      await processor.process(
        jobFor({
          videoId: video.id,
          channelId: 'not-the-channel',
          storageKey: 'videos/elsewhere/original.mp4',
        }),
      );

      const updated = await videoRepo.findOneByOrFail({ id: video.id });
      expect(updated.status).toBe(VideoStatus.READY);
      expect(updated.thumbnail_key).toBe(thumbKey);
    });

    it('skips a job whose video already left processing (failed by the sweep)', async () => {
      const { video, thumbKey } = await storedVideo(VideoStatus.FAILED);

      await processor.process(jobFor({ videoId: video.id }));

      const row = await videoRepo.findOneByOrFail({ id: video.id });
      expect(row.status).toBe(VideoStatus.FAILED);
      await expect(storageService.headObject(thumbKey)).rejects.toThrow();
    });

    it('does not overwrite a ready video when a re-delivered job fails for good', async () => {
      const { video } = await storedVideo(VideoStatus.READY);

      await processor.onFailed(
        jobFor({ videoId: video.id }, 3),
        new Error('ffprobe failed: connection reset'),
      );

      const row = await videoRepo.findOneByOrFail({ id: video.id });
      expect(row.status).toBe(VideoStatus.READY);
      expect(row.processing_error).toBeNull();
    });
  });
});
