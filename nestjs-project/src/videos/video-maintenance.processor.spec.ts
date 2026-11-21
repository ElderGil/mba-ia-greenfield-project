import { getQueueToken } from '@nestjs/bullmq';
import { Test } from '@nestjs/testing';
import { VideoMaintenanceProcessor } from './video-maintenance.processor';
import { VideoMaintenanceService } from './video-maintenance.service';
import {
  VIDEO_MAINTENANCE_EVERY_MS,
  VIDEO_MAINTENANCE_KEEP_JOBS,
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_MAINTENANCE_SCHEDULER,
} from './videos-queue.constants';

describe('VideoMaintenanceProcessor', () => {
  const mockQueue = { upsertJobScheduler: jest.fn() };
  const mockService = { sweep: jest.fn() };
  let processor: VideoMaintenanceProcessor;

  beforeEach(async () => {
    jest.clearAllMocks();
    const module = await Test.createTestingModule({
      providers: [
        VideoMaintenanceProcessor,
        {
          provide: getQueueToken(VIDEO_MAINTENANCE_QUEUE),
          useValue: mockQueue,
        },
        { provide: VideoMaintenanceService, useValue: mockService },
      ],
    }).compile();
    processor = module.get(VideoMaintenanceProcessor);
  });

  it('should register one idempotent scheduler for the sweep on startup', async () => {
    await processor.onModuleInit();

    expect(mockQueue.upsertJobScheduler).toHaveBeenCalledWith(
      VIDEO_MAINTENANCE_SCHEDULER,
      { every: VIDEO_MAINTENANCE_EVERY_MS },
      expect.objectContaining({ name: 'sweep' }),
    );
  });

  it('should keep a bounded history of sweep jobs, since one runs every 15 minutes forever', async () => {
    await processor.onModuleInit();

    const [, , template] = mockQueue.upsertJobScheduler.mock.calls[0] as [
      string,
      unknown,
      { opts?: { removeOnComplete?: unknown; removeOnFail?: unknown } },
    ];
    expect(template.opts).toEqual({
      removeOnComplete: VIDEO_MAINTENANCE_KEEP_JOBS,
      removeOnFail: VIDEO_MAINTENANCE_KEEP_JOBS,
    });
  });

  it('should run the sweep with the current time for each scheduled job', async () => {
    mockService.sweep.mockResolvedValue({ abortedDrafts: 0, failedOrphans: 0 });

    await processor.process();

    expect(mockService.sweep).toHaveBeenCalledWith(expect.any(Date));
  });
});
