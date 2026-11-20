---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    source: "context7 /nestjs/docs.nestjs.com (branch 11.0.0, techniques/queues) + npm view @nestjs/bullmq@11.0.5 (CommonJS, Jest-compatible)"
    fetched_at: "2026-11-16T21:27:15-03:00"
  bullmq:
    version: "^6.7.6"
    source: "context7 /taskforcesh/bullmq (v6.3.11; installed 6.7.6) + npm view bullmq@6.7.6"
    fetched_at: "2026-11-16T21:27:15-03:00"
  ioredis:
    version: "^5.11.1"
    source: "npm view ioredis@5.11.1 (peerOptional compatible with typeorm@0.3.28 and bullmq@6.7.6); maxRetriesPerRequest behaviour confirmed in context7 /taskforcesh/bullmq"
    fetched_at: "2026-11-16T21:27:15-03:00"
  "@aws-sdk/client-s3":
    version: "^3.1170.0"
    source: "context7 /aws/aws-sdk-js-v3 (v3.1153.0; installed 3.1170.0) + npm view @aws-sdk/client-s3@3.1170.0"
    fetched_at: "2026-11-16T21:27:15-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1170.0"
    source: "context7 /aws/aws-sdk-js-v3 (v3.1153.0, packages/s3-request-presigner README; installed 3.1170.0) + npm view @aws-sdk/s3-request-presigner@3.1170.0"
    fetched_at: "2026-11-16T21:27:15-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-16T21:27:05-0300"
---

# phase-03-videos — Library References

Distilled official API references for libraries decided in Phase 03 (`technical-decisions-phase-03-videos.md`). Verified against npm registry compatibility with `@nestjs/core ^11.0.1` and Node.js 25.

> **Re-verification (2026-11-17, peer review):** the first version of this file cited only `npm view` + docs, because context7 was not configured in the Antigravity MCP config. The APIs below were re-checked through context7. Version gaps between the context7 index and the installed packages, flagged per `CLAUDE.md` → Library Documentation Lookup: `bullmq` (context7 v6.3.11, installed 6.7.6) and `@aws-sdk/*` (context7 v3.1153.0, installed 3.1170.0). The installed versions are the ones exercised by the unit, integration and e2e suites against real Redis and MinIO.

> **Final review additions (2026-11-20):** APIs adopted after the peer review, each checked through context7 before use (same version gaps as above):
> - `@aws-sdk/client-s3`: `S3Client({ requestChecksumCalculation: 'WHEN_REQUIRED' })` on the presign client (UploadPart does not require a checksum; with the default `WHEN_SUPPORTED` the SDK signs a CRC32 of the empty body into the URL). `ListPartsCommand` with `MaxParts` / `PartNumberMarker`, paged on `IsTruncated`: the documented `paginateListParts` loops forever against MinIO/silo, whose last page carries `NextPartNumberMarker: "0"`.
> - `bullmq`: `queue.upsertJobScheduler(id, { every }, { name })` for the maintenance sweep (idempotent across worker starts, one run per tick across replicas); `UnrecoverableError` is the error BullMQ uses to fail a job for good (stalled past `maxStalledCount`), so `onFailed` treats it as final; `job.getState()` to tell a live job from a lost one.
> - `@nestjs/platform-express` (Nest core, not a Phase 03 lib): `NestFactory.create<NestExpressApplication>()` + `app.useBodyParser('json', { limit })` to raise the 100 kB default (NestJS docs, `faq/raw-body`).

---

### @nestjs/bullmq

**Version line:** `^11.0.5` (CommonJS build; peerDependencies: `@nestjs/core ^10 || ^11`, `bullmq ^3 || ^4 || ^5 || ^6`; avoids ESM-only Jest friction of v12).
**Decided in:** `phase-03-videos/TD-01` (Option A — BullMQ + Redis).

#### Root configuration (`BullModule.forRootAsync`)

```typescript
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import queueConfig from './config/queue.config';

BullModule.forRootAsync({
  imports: [ConfigModule],
  inject: [queueConfig.KEY],
  useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
    connection: {
      host: cfg.redisHost,
      port: cfg.redisPort,
      password: cfg.redisPassword || undefined,
    },
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: 100,
      removeOnFail: 500,
    },
  }),
});
```

#### Queue registration, producer (`@InjectQueue`), and consumer (`@Processor` + `WorkerHost`)

```typescript
// Feature module
BullModule.registerQueue({ name: 'video-processing' });

// Producer service
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';

constructor(
  @InjectQueue('video-processing') private readonly videoQueue: Queue,
) {}

await this.videoQueue.add('process-video', { videoId, storageKey }, {
  jobId: `process-video-${videoId}`,
});

// Consumer processor (in video-worker)
import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';

@Processor('video-processing', { concurrency: 2 })
export class VideoProcessingProcessor extends WorkerHost {
  async process(job: Job<VideoProcessingJobData>): Promise<void> {
    // Runs ffprobe + ffmpeg thumbnail extraction
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<VideoProcessingJobData> | undefined, err: Error): Promise<void> {
    // Only mark permanent failure once attempts are exhausted
  }
}
```

---

### bullmq

**Version line:** `^6.7.6`.
**Decided in:** `phase-03-videos/TD-01`.

- `Job` fields used in failure handling: `job.attemptsMade` vs `job.opts.attempts` — mark DB status `failed` when `job.attemptsMade >= (job.opts.attempts ?? 1)`.
- `Queue.close()` / `NestFactory.createApplicationContext()` `app.close()` cleanly shuts down BullMQ workers on `SIGTERM`.
- In integration tests, drain/obliterate test queues or `queue.obliterate({ force: true })` / `queue.drain()` in `beforeEach`/`afterAll` and close the module so Jest exits cleanly without open Redis handles.

---

### ioredis

**Version line:** `^5.11.1` (satisfies both `typeorm@0.3.28` `peerOptional ^5.0.4` and `bullmq@6.7.6` `>=5.0.0`).
**Decided in:** `phase-03-videos/TD-01`.

- BullMQ manages its own `ioredis` connections from `connection: { host, port, password }` — note BullMQ requires `maxRetriesPerRequest: null` on worker connections (automatically applied by BullMQ when passing plain `connection` options).

---

### @aws-sdk/client-s3

**Version line:** `^3.1170.0`.
**Decided in:** `phase-03-videos/TD-02`, `phase-03-videos/TD-03`, `phase-03-videos/TD-07`.

#### Client setup for MinIO + AWS S3

```typescript
import { S3Client } from '@aws-sdk/client-s3';

const s3Client = new S3Client({
  region: cfg.region,                 // e.g., 'us-east-1'
  endpoint: cfg.endpoint,             // e.g., 'http://minio:9000'
  credentials: {
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
  },
  forcePathStyle: cfg.forcePathStyle, // true for MinIO
});
```

#### Multipart upload commands & streaming commands

- **Bucket bootstrap:** `HeadBucketCommand({ Bucket })` → on 404/`NotFound`, `CreateBucketCommand({ Bucket })`.
- **Initiate multipart:** `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → returns `{ UploadId }`.
- **Complete multipart:** `CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: [{ PartNumber, ETag }] } })` (Parts MUST be sorted ascending by `PartNumber`; `ETag` passed as returned by MinIO/S3).
- **Abort multipart:** `AbortMultipartUploadCommand({ Bucket, Key, UploadId })`.
- **Verify object:** `HeadObjectCommand({ Bucket, Key })` → returns `{ ContentLength, ContentType, ETag }`.
- **Upload thumbnail buffer:** `PutObjectCommand({ Bucket, Key, Body: buffer, ContentType: 'image/jpeg' })`.
- **Byte-range read / stream:** `GetObjectCommand({ Bucket, Key, Range: 'bytes=start-end' })` → returns `{ Body, ContentLength, ContentRange, ContentType }`. In Node.js, convert `response.Body` via `Readable.fromWeb(response.Body.transformToWebStream() as ReadableStream)` or check `response.Body instanceof Readable`.
- **Delete object (cleanup/tests):** `DeleteObjectCommand({ Bucket, Key })`.

---

### @aws-sdk/s3-request-presigner

**Version line:** `^3.1170.0`.
**Decided in:** `phase-03-videos/TD-02`, `phase-03-videos/TD-03`.

```typescript
import { UploadPartCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

// Presign multipart part PUT URL (for client direct upload)
const partCmd = new UploadPartCommand({
  Bucket: bucket,
  Key: key,
  UploadId: uploadId,
  PartNumber: partNumber,
});
const url = await getSignedUrl(s3Client, partCmd, { expiresIn: 900 });

// Presign internal GET URL (for video-worker ffprobe/ffmpeg input)
const getCmd = new GetObjectCommand({ Bucket: bucket, Key: key });
const internalUrl = await getSignedUrl(s3Client, getCmd, { expiresIn: 900 });
```
