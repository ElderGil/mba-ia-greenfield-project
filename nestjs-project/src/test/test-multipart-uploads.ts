import type { S3StorageService } from '../storage/s3-storage.service';
import { isNoSuchUpload } from '../videos/video-upload-session';

interface TestMultipartUpload {
  storageKey: string;
  uploadId: string;
}

export class TestMultipartUploads {
  private readonly uploads: TestMultipartUpload[] = [];

  track<T extends TestMultipartUpload>(upload: T): T {
    this.uploads.push(upload);
    return upload;
  }

  owns(uploadId: string): boolean {
    return this.uploads.some((upload) => upload.uploadId === uploadId);
  }

  async abortRemaining(storage: S3StorageService): Promise<void> {
    // Use the IDs created by this test, so concurrent runs and pre-existing
    // uploads in the bucket are never swept by suite teardown.
    await Promise.all(
      this.uploads.splice(0).map(async ({ storageKey, uploadId }) => {
        try {
          await storage.abortMultipartUpload(storageKey, uploadId);
        } catch (error) {
          if (!isNoSuchUpload(error)) throw error;
        }
      }),
    );
  }
}
