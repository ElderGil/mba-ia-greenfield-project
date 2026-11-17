import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import storageConfig from '../config/storage.config';
import { S3StorageService } from './s3-storage.service';
import { StorageModule } from './storage.module';

async function streamToBuffer(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('S3StorageService (integration)', () => {
  let moduleRef: TestingModule;
  let storageService: S3StorageService;
  const createdKeys: string[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig],
        }),
        StorageModule,
      ],
    }).compile();

    await moduleRef.init();
    storageService = moduleRef.get(S3StorageService);
  });

  afterAll(async () => {
    for (const key of createdKeys) {
      await storageService.deleteObject(key).catch(() => undefined);
    }
    await moduleRef.close();
  });

  it('creates bucket idempotently, puts object, heads, reads byte range, and deletes', async () => {
    const key = `tests/storage-int-${Date.now()}.bin`;
    createdKeys.push(key);
    const payload = Buffer.from('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ');

    await storageService.ensureBucket();
    await storageService.putObject(key, payload, 'application/octet-stream');

    const head = await storageService.headObject(key);
    expect(head.contentLength).toBe(payload.length);
    expect(head.contentType).toBe('application/octet-stream');

    const rangeRes = await storageService.getObjectStream(key, 'bytes=10-19');
    const slice = await streamToBuffer(rangeRes.stream);
    expect(slice.toString('utf8')).toBe('ABCDEFGHIJ');
    expect(rangeRes.contentRange).toBe(`bytes 10-19/${payload.length}`);
    expect(rangeRes.contentLength).toBe(10);
  });

  it('completes a multipart upload via presigned part URL directly to MinIO', async () => {
    const key = `tests/multipart-${Date.now()}.mp4`;
    createdKeys.push(key);
    const payload = Buffer.from(
      'fake-mp4-stream-payload-for-s3-multipart-test',
    );

    const uploadId = await storageService.createMultipartUpload(
      key,
      'video/mp4',
    );
    expect(uploadId).toBeTruthy();

    const presignedUrl = await storageService.getPresignedPartUrl(
      key,
      uploadId,
      1,
      300,
    );
    expect(presignedUrl).toContain(key);

    const putRes = await fetch(presignedUrl, {
      method: 'PUT',
      body: payload,
    });
    expect(putRes.ok).toBe(true);
    const etag = putRes.headers.get('etag');
    expect(etag).toBeTruthy();

    await storageService.completeMultipartUpload(key, uploadId, [
      { partNumber: 1, etag: etag! },
    ]);

    const head = await storageService.headObject(key);
    expect(head.contentLength).toBe(payload.length);
  });

  it('aborts an active multipart upload cleanly', async () => {
    const key = `tests/abort-${Date.now()}.mp4`;
    const uploadId = await storageService.createMultipartUpload(
      key,
      'video/mp4',
    );
    await expect(
      storageService.abortMultipartUpload(key, uploadId),
    ).resolves.toBeUndefined();
  });
});
