import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ChannelsService } from '../channels/channels.service';
import { Channel } from '../channels/entities/channel.entity';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import videoConfig from '../config/video.config';
import { S3StorageService } from '../storage/s3-storage.service';
import { Video } from './entities/video.entity';
import { VideosController } from './videos.controller';
import { VideosModule } from './videos.module';
import { VIDEO_PROCESSING_QUEUE } from './videos-queue.constants';
import { VideosQueueService } from './videos-queue.service';
import { VideosUploadService } from './videos-upload.service';
import { VideosService } from './videos.service';

describe('VideosModule', () => {
  it('compiles with all dependencies wired', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [storageConfig, queueConfig, videoConfig],
        }),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
            connection: {
              host: cfg.redisHost,
              port: cfg.redisPort,
            },
          }),
        }),
        VideosModule,
      ],
    })
      .overrideProvider(getRepositoryToken(Video))
      .useValue({})
      .overrideProvider(getRepositoryToken(Channel))
      .useValue({})
      .overrideProvider(DataSource)
      .useValue({})
      .overrideProvider(ChannelsService)
      .useValue({ findByUserId: jest.fn() })
      .overrideProvider(S3StorageService)
      .useValue({})
      .overrideProvider(getQueueToken(VIDEO_PROCESSING_QUEUE))
      .useValue({ add: jest.fn(), close: jest.fn() })
      .compile();

    expect(module.get(VideosController)).toBeInstanceOf(VideosController);
    expect(module.get(VideosService)).toBeInstanceOf(VideosService);
    expect(module.get(VideosUploadService)).toBeInstanceOf(VideosUploadService);
    expect(module.get(VideosQueueService)).toBeInstanceOf(VideosQueueService);
    await module.close();
  });
});
