import { DeleteBucketCommand, S3Client } from '@aws-sdk/client-s3';
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
  // A test failing mid-way must not leave its multipart upload behind.
  const openUploads: { key: string; uploadId: string }[] = [];

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
    for (const { key, uploadId } of openUploads) {
      // NoSuchUpload once completed or aborted by the test itself.
      await storageService
        .abortMultipartUpload(key, uploadId)
        .catch(() => undefined);
    }
    for (const key of createdKeys) {
      await storageService.deleteObject(key).catch(() => undefined);
    }
    await moduleRef.close();
  });

  it('lets the API and the worker create a missing bucket at the same time', async () => {
    // First start: both processes find no bucket and both create it.
    const cfg = { ...storageConfig(), bucket: `race-${Date.now()}` };
    const refs = await Promise.all(
      [1, 2].map(() =>
        Test.createTestingModule({
          providers: [
            S3StorageService,
            { provide: storageConfig.KEY, useValue: cfg },
          ],
        }).compile(),
      ),
    );
    const admin = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle,
      credentials: {
        accessKeyId: cfg.accessKeyId,
        secretAccessKey: cfg.secretAccessKey,
      },
    });

    try {
      await expect(
        Promise.all(
          refs.map((ref) => ref.get(S3StorageService).ensureBucket()),
        ),
      ).resolves.toBeDefined();
    } finally {
      await Promise.all(refs.map((ref) => ref.close()));
      await admin
        .send(new DeleteBucketCommand({ Bucket: cfg.bucket }))
        .catch(() => undefined);
      admin.destroy();
    }
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

    openUploads.push({ key, uploadId });
    expect(uploadId).toBeTruthy();

    const presignedUrl = await storageService.getPresignedPartUrl(
      key,
      uploadId,
      1,
      300,
    );
    expect(presignedUrl).toContain(key);
    // A signed checksum of an empty body (CRC32 AAAAAA==) is accepted by
    // MinIO but makes real S3 reject the client's PUT with BadDigest.
    expect(presignedUrl).not.toMatch(
      /x-amz-checksum-|x-amz-sdk-checksum-algorithm/i,
    );

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

  it('lists the parts already uploaded, across pages, so a client can resume', async () => {
    const key = `tests/list-parts-${Date.now()}.mp4`;
    createdKeys.push(key);
    const uploadId = await storageService.createMultipartUpload(
      key,
      'video/mp4',
    );
    openUploads.push({ key, uploadId });
    const etags: string[] = [];
    for (const partNumber of [1, 2]) {
      const url = await storageService.getPresignedPartUrl(
        key,
        uploadId,
        partNumber,
        60,
      );
      const put = await fetch(url, {
        method: 'PUT',
        body: `part-${partNumber}`,
      });
      etags.push(put.headers.get('etag')!);
    }

    // pageSize 1 forces the NextPartNumberMarker pagination path.
    const parts = await storageService.listUploadedParts(key, uploadId, 1);

    expect(parts).toEqual([
      { partNumber: 1, etag: etags[0], sizeBytes: 6 },
      { partNumber: 2, etag: etags[1], sizeBytes: 6 },
    ]);
    await storageService.abortMultipartUpload(key, uploadId);
  });

  it('aborts an active multipart upload cleanly', async () => {
    const key = `tests/abort-${Date.now()}.mp4`;
    const uploadId = await storageService.createMultipartUpload(
      key,
      'video/mp4',
    );
    openUploads.push({ key, uploadId });
    await expect(
      storageService.abortMultipartUpload(key, uploadId),
    ).resolves.toBeUndefined();
  });

  it('lists incomplete uploads across pages and filters by prefix', async () => {
    const stamp = Date.now();
    const matchingPrefix = `tests/incomplete-${stamp}/`;
    const firstKey = `${matchingPrefix}a.mp4`;
    const secondKey = `${matchingPrefix}b.mp4`;
    const otherKey = `tests/other-${stamp}/c.mp4`;

    const firstId = await storageService.createMultipartUpload(
      firstKey,
      'video/mp4',
    );
    const secondId = await storageService.createMultipartUpload(
      secondKey,
      'video/mp4',
    );
    const otherId = await storageService.createMultipartUpload(
      otherKey,
      'video/mp4',
    );
    openUploads.push(
      { key: firstKey, uploadId: firstId },
      { key: secondKey, uploadId: secondId },
      { key: otherKey, uploadId: otherId },
    );

    // maxUploads=1 forces cursor pagination across multiple S3 responses.
    const found: Array<{ key: string; uploadId: string }> = [];
    for await (const upload of storageService.listIncompleteUploads(
      matchingPrefix,
      1,
    )) {
      found.push({ key: upload.key, uploadId: upload.uploadId });
    }

    expect(found).toEqual(
      expect.arrayContaining([
        { key: firstKey, uploadId: firstId },
        { key: secondKey, uploadId: secondId },
      ]),
    );
    expect(found).toHaveLength(2);
    expect(found.some((u) => u.key === otherKey)).toBe(false);
  });
});
