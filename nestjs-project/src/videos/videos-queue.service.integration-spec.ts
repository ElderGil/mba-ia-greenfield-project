import { BullModule, getQueueToken } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { Queue } from 'bullmq';
import queueConfig, { bullRootOptions } from '../config/queue.config';
import { VIDEO_PROCESSING_QUEUE } from './videos-queue.constants';
import { VideosQueueService } from './videos-queue.service';

describe('VideosQueueService (integration)', () => {
  let moduleRef: TestingModule;
  let queueService: VideosQueueService;
  let queue: Queue;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [queueConfig],
        }),
        BullModule.forRootAsync({
          inject: [queueConfig.KEY],
          useFactory: (cfg: ConfigType<typeof queueConfig>) =>
            bullRootOptions(cfg),
        }),
        BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
      ],
      providers: [VideosQueueService],
    }).compile();

    queueService = moduleRef.get(VideosQueueService);
    queue = moduleRef.get<Queue>(getQueueToken(VIDEO_PROCESSING_QUEUE));
    await queue.obliterate({ force: true });
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await moduleRef.close();
  });

  it('keeps test jobs under their own prefix, invisible to the real worker', async () => {
    const jobId = await queueService.enqueueProcessVideo({
      videoId: `isolation-${Date.now()}`,
      channelId: 'chan-1',
      storageKey: 'videos/chan-1/isolation/original.mp4',
      mimeType: 'video/mp4',
    });
    expect(queue.opts.prefix).toBe('streamtube-test');

    // The queue the compose video-worker consumes (default prefix).
    const realQueue = new Queue(VIDEO_PROCESSING_QUEUE, {
      connection: queue.opts.connection,
    });
    try {
      expect(await realQueue.getJob(jobId)).toBeUndefined();
    } finally {
      await realQueue.close();
    }
  });

  it('persists a process-video job in Redis via BullMQ', async () => {
    const videoId = `vid-${Date.now()}`;
    const jobId = await queueService.enqueueProcessVideo({
      videoId,
      channelId: 'chan-1',
      storageKey: `videos/chan-1/${videoId}/original.mp4`,
      mimeType: 'video/mp4',
    });

    expect(jobId).toBe(`process-video-${videoId}`);

    const job = await queue.getJob(jobId);
    expect(job).toBeDefined();
    expect(job!.name).toBe('process-video');
    expect(job!.data).toEqual({
      videoId,
      channelId: 'chan-1',
      storageKey: `videos/chan-1/${videoId}/original.mp4`,
      mimeType: 'video/mp4',
    });
    expect(job!.opts.attempts).toBe(3);
  });
});
