import { IsNull, type FindOptionsWhere, type Repository } from 'typeorm';
import type { S3StorageService } from '../storage/s3-storage.service';
import { type Video, VideoStatus } from './entities/video.entity';

/**
 * The one rule for leaving a draft upload. Complete, abort and the
 * maintenance sweep all claim the draft with a conditional UPDATE on this
 * predicate before any destructive storage call, so exactly one of them owns
 * the multipart upload: complete moves the row to processing, a discard
 * detaches the upload id. Whoever loses the claim never touches storage.
 */
export function draftUploadClaim(
  videoId: string,
  uploadId: string,
): FindOptionsWhere<Video> {
  return { id: videoId, status: VideoStatus.DRAFT, upload_id: uploadId };
}

export function isNoSuchUpload(err: unknown): boolean {
  return (err as { name?: string } | null)?.name === 'NoSuchUpload';
}

export function isObjectNotFound(err: unknown): boolean {
  const s3Err = err as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  } | null;
  return (
    s3Err?.name === 'NotFound' ||
    s3Err?.name === 'NoSuchKey' ||
    s3Err?.$metadata?.httpStatusCode === 404
  );
}

/**
 * Aborts a draft's multipart upload and deletes the draft. Returns false when
 * another operation (a complete, another abort or sweep) owned it first.
 *
 * The upload id is detached before the abort and put back if the abort
 * fails: the upload is still open, so the owner can resume it and the next
 * sweep retries. A draft left without an upload id (process killed mid-way)
 * is deleted by the sweep once stale.
 */
export async function discardDraftUpload(
  videos: Repository<Video>,
  storage: S3StorageService,
  video: Pick<Video, 'id' | 'storage_key' | 'upload_id'>,
): Promise<boolean> {
  if (video.storage_key && video.upload_id) {
    const claim = await videos.update(
      draftUploadClaim(video.id, video.upload_id),
      { upload_id: null },
    );
    if (claim.affected !== 1) return false;

    try {
      await storage.abortMultipartUpload(video.storage_key, video.upload_id);
    } catch (err) {
      // Already gone (lifecycle rule, earlier sweep): nothing left to abort.
      if (!isNoSuchUpload(err)) {
        await videos.update(
          { id: video.id, status: VideoStatus.DRAFT, upload_id: IsNull() },
          { upload_id: video.upload_id },
        );
        throw err;
      }
    }
  }

  const removed = await videos.delete({
    id: video.id,
    status: VideoStatus.DRAFT,
    upload_id: IsNull(),
  });
  return removed.affected === 1;
}
