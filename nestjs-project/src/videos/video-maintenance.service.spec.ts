import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { type FindOperator, type Repository } from 'typeorm';
import type { S3StorageService } from '../storage/s3-storage.service';
import { deferred } from '../test/deferred';
import { type Video, VideoStatus } from './entities/video.entity';
import { VideoMaintenanceService } from './video-maintenance.service';
import { discardDraftUpload, draftUploadClaim } from './video-upload-session';
import type { VideoProcessingJobData } from './videos-queue.constants';

type Row = Pick<Video, 'id' | 'status' | 'storage_key' | 'upload_id'>;
type Where = Partial<Record<keyof Row, unknown>>;

// One row with conditional writes, enough to replay a chosen interleaving.
function inMemoryRow(row: Row, beforeDraftRead: Promise<void>) {
  const matches = (where: Where) =>
    where.id === row.id &&
    where.status === row.status &&
    (where.upload_id === undefined ||
      where.upload_id === row.upload_id ||
      ((where.upload_id as FindOperator<unknown>)?.type === 'isNull' &&
        row.upload_id === null));
  return {
    find: async ({ where }: { where: Where }) => {
      if (where.status !== VideoStatus.DRAFT) return [];
      const snapshot = { ...row };
      await beforeDraftRead;
      return [snapshot];
    },
    findOne: () => Promise.resolve({ ...row }),
    update: (where: Where, changes: Partial<Row>) => {
      if (!matches(where)) return Promise.resolve({ affected: 0 });
      Object.assign(row, changes);
      return Promise.resolve({ affected: 1 });
    },
    delete: (where: Where) =>
      Promise.resolve({ affected: matches(where) ? 1 : 0 }),
  };
}

describe('VideoMaintenanceService', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => jest.restoreAllMocks());

  it('never aborts a session that complete claims after a failed discard put the upload id back', async () => {
    const videoId = '11111111-1111-4111-8111-111111111111';
    const uploadId = 'open-multipart';
    const row: Row = {
      id: videoId,
      status: VideoStatus.DRAFT,
      storage_key: `videos/22222222-2222-4222-8222-222222222222/${videoId}/original.mp4`,
      upload_id: uploadId,
    };
    const discardDetached = deferred();
    const releaseDiscardError = deferred();
    const repo = inMemoryRow(row, discardDetached.promise);
    const abortedUploads: string[] = [];
    let abortCalls = 0;
    const storage = {
      // A store that does list the session, older than the draft TTL.
      listIncompleteUploads: async function* () {
        yield* await Promise.resolve([
          { key: row.storage_key, uploadId, initiated: new Date(0) },
        ]);
      },
      abortMultipartUpload: async (_key: string, id: string) => {
        if (++abortCalls === 1) {
          discardDetached.resolve();
          await releaseDiscardError.promise;
          throw new Error('Transient storage error in the manual abort');
        }
        abortedUploads.push(id);
      },
    };
    const service = new VideoMaintenanceService(
      repo as unknown as Repository<Video>,
      storage as unknown as S3StorageService,
      {} as Queue<VideoProcessingJobData>,
      { draftTtlHours: 24, processingStuckMinutes: 30 } as never,
    );

    // The sweep reads the stale draft, then a manual abort detaches the
    // upload id, fails at the storage and puts it back.
    const sweep = service.sweep(new Date());
    const manual = discardDraftUpload(
      repo as unknown as Repository<Video>,
      storage as unknown as S3StorageService,
      { ...row },
    );
    await discardDetached.promise;
    await new Promise((resolve) => setImmediate(resolve));
    releaseDiscardError.resolve();
    await expect(manual).rejects.toThrow('Transient storage error');
    expect(row.upload_id).toBe(uploadId);
    const completeClaim = await repo.update(
      draftUploadClaim(videoId, uploadId) as Where,
      { status: VideoStatus.PROCESSING },
    );
    await sweep;

    expect(completeClaim.affected).toBe(1);
    expect(row.status).toBe(VideoStatus.PROCESSING);
    expect(abortedUploads).toEqual([]);
  });
});
