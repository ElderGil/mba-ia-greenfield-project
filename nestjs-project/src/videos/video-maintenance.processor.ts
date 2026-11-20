import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { type OnModuleInit } from '@nestjs/common';
import { Queue } from 'bullmq';
import { VideoMaintenanceService } from './video-maintenance.service';
import {
  VIDEO_MAINTENANCE_EVERY_MS,
  VIDEO_MAINTENANCE_QUEUE,
  VIDEO_MAINTENANCE_SCHEDULER,
} from './videos-queue.constants';

// A BullMQ job scheduler (not a local timer) so that with several worker
// replicas each sweep runs exactly once.
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
      { name: 'sweep' },
    );
  }

  async process(): Promise<void> {
    await this.maintenance.sweep(new Date());
  }
}
