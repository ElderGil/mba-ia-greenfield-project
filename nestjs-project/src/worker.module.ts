import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Channel } from './channels/entities/channel.entity';
import databaseConfig from './config/database.config';
import { envValidationSchema } from './config/env.validation';
import queueConfig, { bullRootOptions } from './config/queue.config';
import storageConfig from './config/storage.config';
import videoConfig from './config/video.config';
import { StorageModule } from './storage/storage.module';
import { User } from './users/entities/user.entity';
import { Video } from './videos/entities/video.entity';
import { MediaProcessorService } from './videos/media-processor.service';
import { VideoProcessingProcessor } from './videos/video-processing.processor';
import { VideoMaintenanceProcessor } from './videos/video-maintenance.processor';
import { VideoMaintenanceService } from './videos/video-maintenance.service';
import {
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_PROCESSING_QUEUE,
} from './videos/videos-queue.constants';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [databaseConfig, storageConfig, queueConfig, videoConfig],
      validationSchema: envValidationSchema,
      validationOptions: { allowUnknown: true, abortEarly: false },
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [databaseConfig.KEY],
      useFactory: (dbConfig: ConfigType<typeof databaseConfig>) => ({
        type: 'postgres',
        host: dbConfig.host,
        port: dbConfig.port,
        username: dbConfig.username,
        password: dbConfig.password,
        database: dbConfig.name,
        entities: [User, Channel, Video],
        synchronize: false,
      }),
    }),
    TypeOrmModule.forFeature([Video]),
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (qConfig: ConfigType<typeof queueConfig>) => ({
        ...bullRootOptions(qConfig),
      }),
    }),
    BullModule.registerQueue(
      { name: VIDEO_PROCESSING_QUEUE },
      { name: VIDEO_MAINTENANCE_QUEUE },
    ),
    StorageModule,
  ],
  providers: [
    MediaProcessorService,
    VideoProcessingProcessor,
    VideoMaintenanceService,
    VideoMaintenanceProcessor,
  ],
})
export class WorkerModule {}
