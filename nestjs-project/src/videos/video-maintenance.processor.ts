import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { type OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { VideoMaintenanceService } from './video-maintenance.service';
import {
  VIDEO_MAINTENANCE_EVERY_MS,
  VIDEO_MAINTENANCE_KEEP_JOBS,
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_MAINTENANCE_SCHEDULER,
} from './videos-queue.constants';

// A BullMQ job scheduler (not a local timer) so that several worker replicas
// share one sweep per interval. Delivery is at least once (a stalled job can
// run again), which is safe: every write in the sweep is conditional.
@Processor(VIDEO_MAINTENANCE_QUEUE)
export class VideoMaintenanceProcessor
  extends WorkerHost
  implements OnModuleInit
{
  constructor(
    @InjectQueue(VIDEO_MAINTENANCE_QUEUE)
    private readonly maintenanceQueue: Queue,
    private readonly maintenance: VideoMaintenanceService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    // Upsert is idempotent: every worker start keeps a single scheduler.
    await this.maintenanceQueue.upsertJobScheduler(
      VIDEO_MAINTENANCE_SCHEDULER,
      { every: VIDEO_MAINTENANCE_EVERY_MS },
      {
        name: 'sweep',
        // Without a bound, one job per run accumulates in Redis forever.
        opts: {
          removeOnComplete: VIDEO_MAINTENANCE_KEEP_JOBS,
          removeOnFail: VIDEO_MAINTENANCE_KEEP_JOBS,
        },
      },
    );
  }

  async process(): Promise<void> {
    await this.maintenance.sweep(new Date());
  }
}
