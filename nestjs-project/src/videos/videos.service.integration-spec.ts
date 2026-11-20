import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { ChannelsModule } from '../channels/channels.module';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import databaseConfig from '../config/database.config';
import storageConfig from '../config/storage.config';
import { S3StorageService } from '../storage/s3-storage.service';
import { StorageModule } from '../storage/storage.module';
import { cleanAllTables } from '../test/create-test-data-source';
import { User } from '../users/entities/user.entity';
import { Video, VideoStatus } from './entities/video.entity';
import { VideosService } from './videos.service';

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('VideosService (integration)', () => {
  let moduleRef: TestingModule;
  let dataSource: DataSource;
  let videosService: VideosService;
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
            entities: [User, Channel, RefreshToken, VerificationToken, Video],
          }),
        }),
        TypeOrmModule.forFeature([Video]),
        ChannelsModule,
        StorageModule,
      ],
      providers: [VideosService],
    }).compile();

    await moduleRef.init();
    dataSource = moduleRef.get(DataSource);
    videosService = moduleRef.get(VideosService);
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

  it('streams partial byte ranges, full download, and thumbnail from MinIO', async () => {
    const user = await userRepo.save(
      userRepo.create({
        email: 'streamer@example.com',
        password: 'hash',
        is_confirmed: true,
      }),
    );
    const channel = await channelsService.createChannel(user.id, user.email);

    const videoBytes = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz');
    const thumbBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

    const video = await videoRepo.save(
      videoRepo.create({
        channel_id: channel.id,
        short_code: 'StreamInt11',
        title: 'Stream Integration',
        original_filename: 'stream-test.mp4',
        status: VideoStatus.READY,
        mime_type: 'video/mp4',
        size_bytes: String(videoBytes.length),
      }),
    );

    const storageKey = `videos/${channel.id}/${video.id}/original.mp4`;
    const thumbKey = `thumbnails/${channel.id}/${video.id}/thumb.jpg`;
    createdKeys.push(storageKey, thumbKey);

    await storageService.putObject(storageKey, videoBytes, 'video/mp4');
    await storageService.putObject(thumbKey, thumbBytes, 'image/jpeg');
    await videoRepo.update(
      { id: video.id },
      { storage_key: storageKey, thumbnail_key: thumbKey },
    );

    const partial = await videosService.getVideoStream(
      'StreamInt11',
      'bytes=10-15',
    );
    const partialBuf = await streamToBuffer((await partial.open()).stream);
    expect(partial.isPartial).toBe(true);
    expect(partial.contentRange).toBe(`bytes 10-15/${videoBytes.length}`);
    expect(partialBuf.toString('utf8')).toBe('abcdef');

    const download = await videosService.getVideoDownload('StreamInt11');
    const fullBuf = await streamToBuffer((await download.open()).stream);
    expect(download.filename).toBe('stream-test.mp4');
    expect(fullBuf).toEqual(videoBytes);

    const thumb = await videosService.getThumbnailStream('StreamInt11');
    const thumbBuf = await streamToBuffer((await thumb.open()).stream);
    expect(thumb.contentType).toBe('image/jpeg');
    expect(thumbBuf).toEqual(thumbBytes);
  });
});
