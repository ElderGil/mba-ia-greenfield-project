import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { VIDEO_PROCESSING_QUEUE } from './videos-queue.constants';
import { VideosQueueService } from './videos-queue.service';

describe('VideosQueueService', () => {
  it('enqueues process-video job with deterministic jobId and exponential backoff', async () => {
    const addMock = jest.fn().mockResolvedValue({ id: 'process-video-v1' });
    const module = await Test.createTestingModule({
      providers: [
        VideosQueueService,
        {
          provide: getQueueToken(VIDEO_PROCESSING_QUEUE),
          useValue: { add: addMock },
        },
      ],
    }).compile();

    const service = module.get(VideosQueueService);
    const payload = {
      videoId: 'v1',
      channelId: 'c1',
      storageKey: 'videos/c1/v1/original.mp4',
      mimeType: 'video/mp4',
    };

    const jobId = await service.enqueueProcessVideo(payload);

    expect(jobId).toBe('process-video-v1');
    expect(addMock).toHaveBeenCalledWith('process-video', payload, {
      jobId: 'process-video-v1',
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
    });
  });
});
