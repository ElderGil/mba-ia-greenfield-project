---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-20T21:02:59-0300"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-20T21:02:58-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-20T21:00:44-0300"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o módulo de vídeos no backend (`nestjs-project/`) com armazenamento em object storage S3/MinIO, upload multipart via URLs pré-assinadas para arquivos de até 10 GiB com pré-cadastro automático em rascunho (`draft`), processamento assíncrono via BullMQ/Redis em worker dedicado com FFmpeg/ffprobe (metadados + thumbnail), URL curta única (`short_code`), streaming via HTTP `206 Partial Content` e download completo, tudo orquestrado via Docker Compose.

---

## Step Implementations

### SI-03.1 — Dependencies, Config Namespaces, Env Validation, and Docker Compose

**Description:** Install Phase 03 npm packages (`@nestjs/bullmq`, `bullmq`, `ioredis`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`), create `storage`, `queue`, and `video` config namespaces, extend Joi env validation, install `ffmpeg` in `Dockerfile.dev`, and add `minio`, `redis`, and `video-worker` services to `compose.yaml`.

**Technical actions:**

1. Install dependencies inside `nestjs-api`: `@nestjs/bullmq@^11.0.5`, `bullmq@^6.7.6`, `ioredis@^5.11.1`, `@aws-sdk/client-s3@^3.1170.0`, `@aws-sdk/s3-request-presigner@^3.1170.0` (per `phase-03-videos/TD-01`, `TD-02`, `TD-03`; versions as implemented: the plan originally listed `@nestjs/bullmq@^12.0.2` and `ioredis@^6.0.0`, replaced during SI-03.1 because `12.x` is ESM-only, see TD-01 revision).
2. Create `src/config/storage.config.ts` (`registerAs('storage', ...)`), `src/config/queue.config.ts` (`registerAs('queue', ...)`), and `src/config/video.config.ts` (`registerAs('video', ...)` with `maxFileSizeBytes`, `defaultPartSizeBytes`, `presignedUrlExpiresInSeconds`) following `phase-01-configuracao-base/TD-03`.
3. Extend `src/config/env.validation.ts` (`S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `VIDEO_MAX_SIZE_BYTES`, `VIDEO_UPLOAD_PART_SIZE_BYTES`), update `nestjs-project/.env.example` and `nestjs-project/.env`, and register the new configs in `ConfigModule.forRoot` (`AppModule` and `WorkerModule`).
4. Update `nestjs-project/Dockerfile.dev` to install `ffmpeg` (`apt install -y procps curl ffmpeg`) so both `video-worker` and integration tests inside `nestjs-api` have `ffmpeg` and `ffprobe` binaries (per `phase-03-videos/TD-05`).
5. Update `nestjs-project/compose.yaml` to add `minio` (`minio/minio:latest`, ports `9000`/`9001`, healthcheck; _Revised 2026-11-20 (final review)_: shipped as `pgsty/silo:RELEASE.2026-11-12T00-00-00Z`, since `minio/minio` returned `pull access denied`), `redis` (`redis:7-alpine`, port `6379`, AOF persistence, healthcheck), and `video-worker` (built from `Dockerfile.dev`, `npm run start:worker:dev`, depending on healthy `db`, `redis`, `minio`).

**Tests:**

| Artifact | Layer | Test file |
|---|---|---|
| `src/config/env.validation.ts` | Integration | `src/config/env.validation.integration-spec.ts` (update to verify storage/queue/video env defaults and required rules) |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose up -d` starts `db`, `mailpit`, `minio`, `redis`, `nestjs-api`, and `video-worker` using service names (`db`, `minio`, `redis`), never `localhost`.
- `ffmpeg -version` and `ffprobe -version` succeed inside `nestjs-api` and `video-worker` containers.
- Starting without required `S3_*` / `REDIS_*` vars fails fast via Joi validation. _Revised 2026-11-20 (round 5): only `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` are required (no fallback in `storage.config` either); `REDIS_*` default to the compose `redis` service._

---

### SI-03.2 — Video Entity, Channel Lookup Helper, and Migration

**Description:** Create the `Video` entity (`videos` table) linked to `Channel`, add `ChannelsService.findByUserId`, and generate the TypeORM migration creating the `videos` table and status enum.

**Technical actions:**

1. Create `src/videos/entities/video.entity.ts` matching `### Data Model → Video` (`VideoStatus` enum `'draft' | 'processing' | 'ready' | 'failed'`, `short_code` unique index, `channel_id` FK → `channels.id`, storage/metadata/error columns).
2. Add `findByUserId(userId: string): Promise<Channel | null>` to `src/channels/channels.service.ts` (reused by `VideosUploadService` and `VideosService` without leaking `Channel` repository across module boundaries).
3. Register `Video` via `TypeOrmModule.forFeature([Video])` (once `VideosModule` exists, or import cleanly in `data-source.ts` discovery) and generate migration `CreateVideos` via `docker compose exec nestjs-api npm run migration:generate -- src/database/migrations/CreateVideos`.
4. Update `src/database/migrations.integration-spec.ts` to include `Video` + the `CreateVideos` migration (ensuring `DROP TYPE IF EXISTS` cleans up enums in `beforeAll` so migration tests stay idempotent) and run `npm run migration:run`.

**Tests:**

| Artifact | Layer | Test file |
|---|---|---|
| `src/videos/entities/video.entity.ts` | Integration | `src/videos/entities/video.entity.integration-spec.ts` |
| `src/channels/channels.service.ts` | Integration | `src/channels/channels.service.integration-spec.ts` (add `findByUserId` test) |
| `src/database/migrations/*-CreateVideos.ts` | Integration | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates `videos` table with `short_code` unique index, `(channel_id, status)` index, and `channel_id` FK.
- `migrations.integration-spec.ts` passes bidirectional apply/revert cleanly even when migrations were already run prior to the test.

---

### SI-03.3 — Phase 03 Domain Exceptions & S3 Storage Service (`StorageModule`)

**Description:** Define Phase 03 domain exceptions and implement `StorageModule` / `S3StorageService` wrapping `@aws-sdk/client-s3` and `@aws-sdk/s3-request-presigner` with automatic bucket bootstrap and streaming support.

**Technical actions:**

1. Extend `src/common/exceptions/domain.exception.ts` with all Phase 03 subclasses listed in `### Error Catalog` (`ChannelNotFoundException`, `VideoNotFoundException`, `VideoAccessDeniedException`, `VideoInvalidStateException`, `VideoNotReadyException`, `UploadLimitExceededException`, `UnsupportedMediaTypeException`, `InvalidUploadPartsException`, `InvalidRangeException`). _Revised 2026-11-20 (final review): `VideoNotReadyException` was removed (public routes answer `404 VideoNotFoundException` for non-ready videos); `TooManyOpenUploadsException` was added._
2. Create `src/storage/s3-storage.service.ts` injecting `storageConfig.KEY` (`S3Client` with `forcePathStyle: cfg.forcePathStyle`) implementing: `ensureBucket()`, `createMultipartUpload()`, `getPresignedPartUrl()`, `completeMultipartUpload()`, `abortMultipartUpload()`, `headObject()`, `putObject()`, `getObjectStream()` (with optional `Range`), `getPresignedGetUrl()`, and `deleteObject()`.
3. Ensure `S3StorageService.onModuleInit()` calls `ensureBucket()` (idempotent `HeadBucketCommand` → `CreateBucketCommand` if missing).
4. Create `src/storage/storage.module.ts` exporting `S3StorageService`.

**Tests:**

| Artifact | Layer | Test file |
|---|---|---|
| `src/storage/storage.module.ts` | Unit | `src/storage/storage.module.spec.ts` |
| `src/storage/s3-storage.service.ts` | Integration | `src/storage/s3-storage.service.integration-spec.ts` (real MinIO container: bucket init, multipart upload, headObject, range getObject, delete) |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `S3StorageService` initializes `streamtube-media` bucket automatically in MinIO on startup.
- Multipart create → presigned part PUT → complete → byte-range `GetObject` → delete works end-to-end against real MinIO.

---

### SI-03.4 — BullMQ Queue Constants & Producer Service

**Description:** Configure `BullModule.forRootAsync` in `AppModule` / `WorkerModule`, define queue constants and typed job payload, and implement `VideosQueueService` to enqueue video processing jobs.

**Technical actions:**

1. Create `src/videos/videos-queue.constants.ts` defining `VIDEO_PROCESSING_QUEUE = 'video-processing'`, `PROCESS_VIDEO_JOB = 'process-video'`, and `VideoProcessingJobData` interface (matching `### Events/Messages`).
2. Create `src/videos/videos-queue.service.ts` injecting `@InjectQueue(VIDEO_PROCESSING_QUEUE)` with `enqueueProcessVideo(data: VideoProcessingJobData): Promise<string>` using deterministic `jobId: \`process-video-\${data.videoId}\`` and exponential backoff (`attempts: 3`, `delay: 2000`).
3. Configure `BullModule.forRootAsync` in `AppModule` using `queueConfig.KEY`.

**Tests:**

| Artifact | Layer | Test file |
|---|---|---|
| `src/videos/videos-queue.service.ts` | Unit | `src/videos/videos-queue.service.spec.ts` |
| `src/videos/videos-queue.service.ts` | Integration | `src/videos/videos-queue.service.integration-spec.ts` (real Redis container: verifies job is enqueued with expected payload and options) |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Enqueuing a `process-video` job persists the job in real Redis with `{ videoId, channelId, storageKey, mimeType }` and `attempts: 3`. _Revised 2026-11-20 (round 5): the payload is `{ videoId }` only; the worker reads the rest from the row._

---

### SI-03.5 — Short Code Utility & Multipart Upload Initiation (`POST /videos/uploads/initiate`)

**Description:** Implement the conflict-free 11-character `short_code` generator and `VideosUploadService.initiateUpload` that validates limits/MIME types, creates the `Video` record in `draft` status, and initiates an S3 multipart upload.

**Technical actions:**

1. Create `src/videos/short-code.util.ts` exporting `generateShortCode()` (`crypto.randomBytes(8).toString('base64url')`, 11 chars) (per `phase-03-videos/TD-06`).
2. Create `src/videos/dto/initiate-upload.dto.ts` (`title`, `filename`, `mimeType`, `sizeBytes` with `class-validator` rules per `### API Contracts`).
3. Create `src/videos/videos-upload.service.ts` implementing `initiateUpload(userId, dto)`:
   - Looks up user's channel via `ChannelsService.findByUserId` (throws `ChannelNotFoundException` if absent).
   - Validates `sizeBytes <= videoConfig.maxFileSizeBytes` (`10737418240` bytes = 10 GiB) and `mimeType` ∈ allowed types (throws `UploadLimitExceededException` / `UnsupportedMediaTypeException`).
   - Inserts `Video` in `draft` status with collision-retry loop on PostgreSQL `23505` for `short_code`, then calls `S3StorageService.createMultipartUpload` and updates `storage_key` + `upload_id` (compensating by deleting the draft row if S3 fails).

**Tests:**

| Artifact | Layer | Test file |
|---|---|---|
| `src/videos/short-code.util.ts` | Unit | `src/videos/short-code.util.spec.ts` |
| `src/videos/videos-upload.service.ts` | Unit | `src/videos/videos-upload.service.spec.ts` |
| `src/videos/videos-upload.service.ts` | Integration | `src/videos/videos-upload.service.integration-spec.ts` (real Postgres + MinIO: draft persisted, unique shortCode, multipart uploadId issued) |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- `initiateUpload` creates a `draft` video with a unique 11-char `short_code` and returns `{ videoId, shortCode, uploadId, storageKey, partSizeBytes, maxParts }`.
- Files > 10 GiB (`10737418240`) throw `UploadLimitExceededException` (`413`) and unsupported MIME types throw `UnsupportedMediaTypeException` (`415`) without calling S3 or creating DB rows.

---

### SI-03.6 — Part URL Signing, Upload Completion & Upload Abort

**Description:** Complete `VideosUploadService` with `signUploadPart`, `completeUpload` (with `HeadObject` verification, atomic `draft → processing` state guard, and BullMQ enqueue), and `abortUpload`.

**Technical actions:**

1. Create `src/videos/dto/sign-upload-part.dto.ts` (`partNumber`: int `1..10000`) and `src/videos/dto/complete-upload.dto.ts` (`parts`: non-empty array of `{ partNumber, etag }`).
2. Implement `VideosUploadService.signUploadPart(userId, videoId, partNumber)`: verifies channel ownership, `status === 'draft'`, `upload_id` present, and returns presigned `UploadPart` URL + `expiresIn`.
3. Implement `VideosUploadService.completeUpload(userId, videoId, dto)`: verifies channel ownership and `status === 'draft'`, claims the row by atomically updating `status` from `'draft'` to `'processing'` (`UPDATE ... WHERE id = :id AND status = 'draft'`; `affected !== 1` → `VideoInvalidStateException`), completes S3 multipart upload (parts sorted ascending; on rejection reverts to `'draft'`), verifies `HeadObject` size ≤ 10 GiB (a `HeadObject` failure or an oversized object marks `'failed'`; the row is updated before the oversized object is deleted), and enqueues `process-video` via `VideosQueueService` (on enqueue failure marks `'failed'` with `processing_error`). _Order revised on 2026-11-17 (peer review): the claim used to run after the S3 completion, which let a concurrent second complete reach S3 and left the row in `processing` if the enqueue failed._
4. Implement `VideosUploadService.abortUpload(userId, videoId)`: verifies channel ownership and `status === 'draft'`, calls `S3StorageService.abortMultipartUpload`, and removes or marks aborted draft cleanly (removing the uncompleted `draft` row so aborted drafts do not pollute channel listings).

**Tests:**

| Artifact | Layer | Test file |
|---|---|---|
| `src/videos/videos-upload.service.ts` | Unit | `src/videos/videos-upload.service.spec.ts` (extend with sign/complete/abort branch & ownership tests) |
| `src/videos/videos-upload.service.ts` | Integration | `src/videos/videos-upload.service.integration-spec.ts` (real Postgres + MinIO + Redis: initiate → presigned PUT → complete → DB `processing` + Redis job present; abort clears MinIO upload) |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- Completing a multipart upload transitions the video atomically from `draft` to `processing` and enqueues exactly one BullMQ job; of two concurrent completes exactly one succeeds and the other gets `VideoInvalidStateException` (`409`).
- A rejected part list reverts the video to `draft`; after the S3 completion, a failed `HeadObject`, an oversized object or a failed enqueue leaves it `failed` with `processing_error`, never `processing` without a job.
- Calling `completeUpload` or `signUploadPart` on a non-owner video throws `VideoAccessDeniedException` (`403`), and on a non-`draft` video throws `VideoInvalidStateException` (`409`).

---

### SI-03.7 — FFmpeg Media Processor & Dedicated Video Worker (`video-worker`)

**Description:** Build `MediaProcessorService` (native `ffprobe`/`ffmpeg` via `child_process.execFile`), `VideoProcessingProcessor` (BullMQ `@Processor`), and the standalone worker entrypoint (`src/worker.main.ts` + `src/worker.module.ts`).

**Technical actions:**

1. Create `src/videos/media-processor.service.ts`:
   - `probeVideo(inputUrlOrPath: string)`: runs `ffprobe -v quiet -print_format json -show_format -show_streams <input>` via `execFile`, parsing `durationSeconds` (float), `width` (int), `height` (int), `codec` (`codec_name` of first video stream). _Revised 2026-11-20 (final review, round 5): `probeVideo(input, mimeType)` / `generateThumbnail(input, duration, mimeType)` force the demuxer from the stored MIME with a protocol whitelist, run ffprobe with `-v error -select_streams V:0 -show_entries …`, and ffmpeg maps `0:V:0` (first video track that is not cover art)._
   - `generateThumbnail(inputUrlOrPath: string, durationSeconds: number)`: computes target timestamp (`durationSeconds >= 1 ? 1 : 0`), runs `ffmpeg -y -ss <ts> -i <input> -vframes 1 -q:v 2 -f image2 <tempJpg>`, reads JPEG buffer, and cleans up temp file in `finally`.
2. Create `src/videos/video-processing.processor.ts` (`@Processor(VIDEO_PROCESSING_QUEUE, { concurrency: 2 })` extending `WorkerHost`):
   - `process(job)`: fetches video row, obtains presigned GET URL (internal MinIO endpoint) for `storage_key` (or downloads to temp file if needed), calls `probeVideo` + `generateThumbnail`, uploads JPEG to `thumbnails/{channelId}/{videoId}/thumb.jpg` via `S3StorageService.putObject`, updates `Video` (`status = 'ready'`, `thumbnail_key`, `duration_seconds`, `width`, `height`, `codec`; _Revised 2026-11-20 (final review)_: `size_bytes` is set by the API from `HeadObject` at complete, not by the worker, `processing_error = null`).
   - `@OnWorkerEvent('failed')`: when `job.attemptsMade >= (job.opts.attempts ?? 1)`, sets `status = 'failed'` and stores truncated `processing_error`.
3. Create `src/worker.module.ts` (imports `ConfigModule`, `TypeOrmModule.forRootAsync`, `BullModule.forRootAsync`, `BullModule.registerQueue`, `StorageModule`, provides `MediaProcessorService` and `VideoProcessingProcessor`) and `src/worker.main.ts` (`NestFactory.createApplicationContext(WorkerModule)` with `app.enableShutdownHooks()`).
4. Add `"start:worker": "node dist/worker.main"` and `"start:worker:dev": "nest start --watch --entryFile worker.main"` scripts (_Revised 2026-11-20 (final review)_: shipped as `ts-node -r tsconfig-paths/register src/worker.main.ts`, without watch; the compose `video-worker` runs `node -r ts-node/register ...` directly so SIGTERM reaches Nest) to `nestjs-project/package.json`.

**Tests:**

| Artifact | Layer | Test file |
|---|---|---|
| `src/videos/media-processor.service.ts` | Integration | `src/videos/media-processor.service.integration-spec.ts` (real `ffmpeg`/`ffprobe` generating a 2s synthetic MP4 fixture and verifying probed metadata + valid JPEG thumbnail) |
| `src/videos/video-processing.processor.ts` | Unit | `src/videos/video-processing.processor.spec.ts` (branching: ready transition, <1s fallback, retry vs terminal failure) |
| `src/videos/video-processing.processor.ts` | Integration | `src/videos/video-processing.processor.integration-spec.ts` (real Postgres + real MinIO + real FFmpeg processing an uploaded MP4 into `ready` + thumbnail in MinIO) |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- Worker processes a job from Redis/BullMQ, extracts `durationSeconds`, `width`, `height`, `codec`, uploads `thumb.jpg` to MinIO, and updates DB status to `ready`.
- Corrupt/unreadable media exhausts retries and transitions DB status to `failed` with non-empty `processing_error`.

---

### SI-03.8 — Video Query, Byte-Range Streaming (`206`), Download & Thumbnail Service

**Description:** Implement `VideosService` for owner status/listing queries and public playback (`206 Partial Content` Range streaming), attachment download, and thumbnail streaming.

**Technical actions:**

1. Create `src/videos/videos.service.ts` with:
   - `getVideoByIdForOwner(userId, videoId)` and `listChannelVideos(userId)` (ownership-scoped via `ChannelsService.findByUserId`).
   - `getReadyVideoByShortCode(shortCode)`: finds video by `short_code` (throws `VideoNotFoundException` if missing; throws `VideoNotReadyException` (`409`) if `status !== 'ready'`). _Revised 2026-11-20 (final review): `404 VideoNotFoundException` for any non-ready video, so a shortCode never reveals an unpublished one._
   - `parseByteRange(rangeHeader: string, totalSize: number)`: strict RFC 9110 single-range parser (`bytes=start-end`, `bytes=start-`, `bytes=-suffix`) throwing `InvalidRangeException` (`416`) on unsatisfiable/malformed ranges.
   - `getVideoStream(shortCode, rangeHeader?)`: calls `S3StorageService.getObjectStream` with resolved byte range, returning `{ stream, contentType, contentLength, totalSize, isPartial, contentRange }`. _Revised 2026-11-20 (final review, round 5): returns a lazy `open()` plus `etag`, `contentType`, `contentLength`, `isPartial`, `contentRange`; the Range to honour comes from `selectRange()` in the HTTP layer, after conditionals._
   - `getVideoDownload(shortCode)` and `getThumbnailStream(shortCode)`: streams full video with sanitized attachment filename and JPEG thumbnail stream.

**Tests:**

| Artifact | Layer | Test file |
|---|---|---|
| `src/videos/videos.service.ts` | Unit | `src/videos/videos.service.spec.ts` (Range parser edge cases, ready-status guard, ownership checks) |
| `src/videos/videos.service.ts` | Integration | `src/videos/videos.service.integration-spec.ts` (real Postgres + MinIO: partial byte slice, full stream, thumbnail stream) |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- `parseByteRange` accurately handles `bytes=0-1023`, `bytes=1024-`, `bytes=-512`, and rejects out-of-bounds ranges with `InvalidRangeException` (`416`).
- Streaming reads only the requested byte range from MinIO without buffering the entire file in memory.

---

### SI-03.9 — Videos REST Controller, Module Wiring & OpenAPI Export

**Description:** Expose all Phase 03 endpoints in `VideosController` with OpenAPI decorators (`@nestjs/swagger` + `ApiErrorEnvelope`), register `VideosModule` in `AppModule`, and update `openapi.json`.

**Technical actions:**

1. Create `src/videos/dto/video-response.dto.ts` (response shapes for initiate, sign-part, complete, and video metadata/status) for clean `@ApiResponse` OpenAPI documentation.
2. Create `src/videos/videos.controller.ts` implementing all routes in `### API Contracts` and `### Authorization Matrix`:
   - Protected (`@ApiBearerAuth('access-token')`): `POST /videos/uploads/initiate`, `POST /videos/:id/uploads/parts`, `POST /videos/:id/uploads/complete`, `POST /videos/:id/uploads/abort`, `GET /videos/:id/uploads/parts`, `GET /videos/me`, `GET /videos/:id/status` (_Revised 2026-11-20 (final review)_: the route is `/:id/status`; `uploads/parts` GET was added to resume uploads).
   - Public (`@Public()`): `GET /videos/:shortCode`, `GET /videos/:shortCode/stream`, `GET /videos/:shortCode/download`, `GET /videos/:shortCode/thumbnail`.
   - Note route ordering in NestJS controller: static/specific prefixes (`uploads/initiate`, `me`, `:id/uploads/...`) declared carefully before `:shortCode` (or distinguish UUID `:id` vs `shortCode` via `ParseUUIDPipe` / route prefixes so `:id` and `:shortCode` never collide! Specifically: `GET /videos/me` before `GET /videos/watch/:shortCode` OR `GET /videos/by-id/:id` vs `GET /videos/:shortCode` — see `### API Contracts` below where `:id` status is `GET /videos/:id/status` and public metadata is `GET /videos/:shortCode` so zero NestJS route ambiguity exists!).
3. Create `src/videos/videos.module.ts` importing `TypeOrmModule.forFeature([Video])`, `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`, `ChannelsModule`, `StorageModule`, and register `VideosModule` in `AppModule`.
4. Run `docker compose exec nestjs-api npm run openapi:export` to update `nestjs-project/openapi.json`.

**Tests:**

| Artifact | Layer | Test file |
|---|---|---|
| `src/videos/videos.module.ts` | Unit | `src/videos/videos.module.spec.ts` (module DI compilation check) |
| `src/openapi-export.ts` | Integration | `src/openapi-export.integration-spec.ts` (existing test verifies exported spec stays valid) |

**Dependencies:** SI-03.6, SI-03.7, SI-03.8

**Acceptance criteria:**

- `VideosModule` compiles cleanly; Swagger UI at `/api/docs` and `nestjs-project/openapi.json` document every Phase 03 route, DTO, and error response.
- Zero route collisions between owner routes and public `:shortCode` routes.

---

### SI-03.10 — End-to-End Video Upload, Processing, Streaming & Download Tests

**Description:** Write comprehensive E2E tests in `nestjs-project/test/videos.e2e-spec.ts` exercising the full real stack (HTTP API + PostgreSQL + MinIO + Redis/BullMQ + FFmpeg worker processing).

**Technical actions:**

1. Create `test/videos.e2e-spec.ts` booting the full `AppModule` + an in-test `VideoProcessingProcessor` (or `WorkerModule` context) connected to real Docker `db`, `minio`, and `redis`, using a real small MP4 generated via `ffmpeg` at test setup.
2. Cover the full happy path: register/confirm/login → `POST /videos/uploads/initiate` (assert `201`, `status: 'draft'`, unique 11-char `shortCode`) → `POST /videos/:id/uploads/parts` (assert presigned URL returned) → HTTP `PUT` part bytes directly to MinIO presigned URL → `POST /videos/:id/uploads/complete` (assert `202` / `processing`) → wait for worker completion → `GET /videos/:id/status` (`ready`, `durationSeconds > 0`, `width`, `height`, `codec`, `thumbnailKey` — _revised 2026-11-20 (final review): `thumbnailUrl`_) → anonymous `GET /videos/:shortCode` (`200`), `GET /videos/:shortCode/thumbnail` (`200 image/jpeg`), `GET /videos/:shortCode/stream` with `Range: bytes=0-511` (`206 Partial Content`, `Accept-Ranges: bytes`, `Content-Range`, exact 512 bytes), `GET /videos/:shortCode/download` (`200`, `Content-Disposition: attachment`).
3. Cover security & failure edge cases: unauthenticated upload rejected (`401`), cross-user upload/complete/status rejected (`403`), >10 GiB upload initiation rejected (`413`), unsupported MIME rejected (`415`), invalid byte range rejected (`416`), streaming a `draft`/`processing` video rejected (`409` — _revised 2026-11-20 (final review): `404`_), upload abort cleanup, and corrupt file transitioning to `failed`.

**Tests:**

| Artifact | Layer | Test file |
|---|---|---|
| `src/videos/videos.controller.ts` & full flow | E2E | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.9

**Acceptance criteria:**

- `docker compose exec nestjs-api npm run test:e2e` passes all existing + new Phase 03 E2E suites.
- Real bytes uploaded directly to MinIO via presigned URL are processed by FFmpeg and streamed back with `206 Partial Content`.

---

### SI-03.11 — Documentation, Diagram, Progress & Definition of Done

**Description:** Update project documentation (`CLAUDE.md`, `GEMINI.md`, `nestjs-project/CLAUDE.md`, `nestjs-project/GEMINI.md`, `docs/diagrams/software-arch.mermaid`, `README.md`, `progress.md`), regenerate `openapi.json`, and run the full Definition of Done checks.

**Technical actions:**

1. Update `docs/diagrams/software-arch.mermaid` replacing `"Message Queue", "TBD"` with `"Message Queue", "BullMQ / Redis"`.
2. Update `CLAUDE.md`, `GEMINI.md`, `nestjs-project/CLAUDE.md`, and `nestjs-project/GEMINI.md` with the Phase 03 videos module, endpoints, `video-worker`, MinIO, and Redis services (ensuring zero references to nonexistent files).
3. Update root `README.md` with Phase 03 status/architecture/commands AND the requested note justifying the use of **Antigravity** to test the newly released **Gemini 4 Hydrogen** model for coding.
4. Update `docs/phases/phase-03-videos/progress.md` and run full Definition of Done inside Docker: `npm test -- --runInBand`, `npm run test:e2e`, `npx tsc --noEmit`, `npm run lint`, `npm run build`, plus live container smoke check (`docker compose up -d` with `video-worker`, `minio`, `redis`).

**Tests:**

| Artifact | Layer | Test file |
|---|---|---|
| Full backend suite | Unit + Integration + E2E | `npm test -- --runInBand` & `npm run test:e2e` |

**Dependencies:** SI-03.10

**Acceptance criteria:**

- Full test suites, `npx tsc --noEmit` (exit 0), `npm run lint` (0 errors on new/modified code; full repo DoD clean), and `npm run build` pass inside container.
- All `CLAUDE.md` / `GEMINI.md` / `README.md` / `progress.md` files match the exact code on disk.

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|---|---|---|
| `id` | `uuid` | PK, generated (`uuid_generate_v4()`) |
| `channel_id` | `uuid` | FK → `channels.id` (`ON DELETE NO ACTION`), not null; covered by the `(channel_id, status)` index |
| `short_code` | `varchar(16)` | unique, not null (11-char base64url per `phase-03-videos/TD-06`) |
| `title` | `varchar(255)` | not null (trimmed) |
| `original_filename` | `varchar(255)` | not null (trimmed; used for the download `Content-Disposition`) |
| `status` | `enum('draft','processing','ready','failed')` | not null, default `'draft'` (per `phase-03-videos/TD-04`) |
| `storage_key` | `varchar(512)` | nullable during pre-S3 init, unique when set |
| `thumbnail_key` | `varchar(512)` | nullable |
| `upload_id` | `varchar(255)` | nullable (active S3 multipart UploadId while in `draft`) |
| `mime_type` | `varchar(128)` | not null |
| `size_bytes` | `bigint` | not null |
| `duration_seconds` | `double precision` | nullable (populated by `ffprobe`) |
| `width` | `integer` | nullable (populated by `ffprobe`) |
| `height` | `integer` | nullable (populated by `ffprobe`) |
| `codec` | `varchar(64)` | nullable (populated by `ffprobe`) |
| `processing_error` | `text` | nullable (populated on `failed`) |
| `created_at` | `timestamp` (without time zone) | default `now()` |
| `updated_at` | `timestamp` (without time zone) | default `now()`, auto-updated |

**Relations:** `Video` belongs to `Channel` (`ManyToOne(() => Channel)`); `Channel` has many `Video`.
**Indexes:** unique index on `short_code`; unique `storage_key`; composite index on `(channel_id, status)`. _Revised 2026-11-20 (final review)_: the migration had also created a single-column `channel_id` index, redundant with the composite one; `1795194064003-DropRedundantVideosChannelIndex` drops it, and the table above now matches the entity and migrations (`original_filename` was missing; timestamps are `timestamp`, not `timestamptz`).

---

### API Contracts

#### POST /videos/uploads/initiate (SI-03.5)

**Request headers:**
- `Authorization: Bearer <access_token>`
- `Content-Type: application/json`

**Request body:**
- `title`: `string`, required — min 1, max 255 characters
- `filename`: `string`, required — original filename (used for extension / download name)
- `mimeType`: `string`, required — one of `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`
- `sizeBytes`: `number`, required — integer `>= 1` and `<= 10737418240` (10 GiB)

**Response 201:**
- `videoId`: `string` (`uuid`)
- `shortCode`: `string` (11-char URL-safe unique code)
- `status`: `'draft'`
- `uploadId`: `string` (S3 multipart upload ID)
- `storageKey`: `string`
- `partSizeBytes`: `number` (default `10485760` = 10 MiB)
- `maxParts`: `number` (`10000`)

**Error responses:**
- `400 VALIDATION_ERROR`: invalid body fields
- `401 Unauthorized`: missing or invalid JWT
- `404 CHANNEL_NOT_FOUND`: authenticated user has no channel
- `413 UPLOAD_LIMIT_EXCEEDED`: `sizeBytes > 10737418240` (10 GiB)
- `415 UNSUPPORTED_MEDIA_TYPE`: `mimeType` not in allowed video MIME types

---

#### POST /videos/:id/uploads/parts (SI-03.6)

**Request headers:**
- `Authorization: Bearer <access_token>`
- `Content-Type: application/json`

**Request body:**
- `partNumber`: `number`, required — integer between `1` and `10000`

**Response 200:**
- `partNumber`: `number`
- `presignedUrl`: `string` (presigned S3 `UploadPart` PUT URL)
- `expiresInSeconds`: `number`

**Error responses:**
- `400 VALIDATION_ERROR`: invalid `id` UUID or `partNumber` out of range
- `401 Unauthorized`: missing or invalid JWT
- `403 VIDEO_ACCESS_DENIED`: video belongs to another channel
- `404 VIDEO_NOT_FOUND`: video does not exist
- `409 VIDEO_INVALID_STATE`: video is not in `draft` status

---

#### GET /videos/:id/uploads/parts (_Revised 2026-11-20 (final review)_)

Lets a client that lost its ETags (reload, crash) resume the upload, as `project-plan.md` §4 requires.

**Response 200:** `{ parts: Array<{ partNumber: number; etag: string; sizeBytes: number }> }`, ascending by `partNumber`, ready for `/uploads/complete`.

**Error responses:** `401`, `403 VIDEO_ACCESS_DENIED`, `404 VIDEO_NOT_FOUND`, `409 VIDEO_INVALID_STATE` (not a draft).

---

#### POST /videos/:id/uploads/complete (SI-03.6)

**Request headers:**
- `Authorization: Bearer <access_token>`
- `Content-Type: application/json`

**Request body:**
- `parts`: `Array<{ partNumber: number; etag: string }>`, required, 1 to 10 000 items, in any order (the API sorts them) (_Revised 2026-11-20 (final review)_: JSON body limit raised to 1 MB so 10 000 parts fit)

**Response 202:**
- `videoId`: `string` (`uuid`)
- `shortCode`: `string`
- `status`: `'processing'`
- `jobId`: `string`

**Error responses:**
- `400 INVALID_UPLOAD_PARTS` / `400 VALIDATION_ERROR`: empty/duplicate/invalid parts or S3 multipart completion rejected
- `401 Unauthorized`: missing or invalid JWT
- `403 VIDEO_ACCESS_DENIED`: video belongs to another channel
- `404 VIDEO_NOT_FOUND`: video does not exist
- `409 VIDEO_INVALID_STATE`: video is not in `draft` status
- `413 UPLOAD_LIMIT_EXCEEDED`: completed S3 object exceeds 10 GiB

---

#### POST /videos/:id/uploads/abort (SI-03.6)

**Request headers:**
- `Authorization: Bearer <access_token>`

**Response 204:** No content.

**Error responses:**
- `401 Unauthorized`: missing or invalid JWT
- `403 VIDEO_ACCESS_DENIED`: video belongs to another channel
- `404 VIDEO_NOT_FOUND`: video does not exist
- `409 VIDEO_INVALID_STATE`: video is not in `draft` status

---

#### GET /videos/me (SI-03.8, SI-03.9)

**Request headers:**
- `Authorization: Bearer <access_token>`

**Response 200:** Array of owner channel videos (`id`, `shortCode`, `title`, `status`, `mimeType`, `sizeBytes`, `durationSeconds`, `width`, `height`, `codec`, `processingError`, `createdAt`, `updatedAt`).

---

#### GET /videos/:id/status (SI-03.8, SI-03.9)

**Request headers:**
- `Authorization: Bearer <access_token>`

**Response 200:** Full owner video status & metadata object (including `processingError` if `failed`).

**Error responses:**
- `401 Unauthorized`, `403 VIDEO_ACCESS_DENIED`, `404 VIDEO_NOT_FOUND`

---

#### GET /videos/:shortCode (SI-03.8, SI-03.9)

**Response 200:** Public video metadata (`id`, `shortCode`, `title`, `status`, `mimeType`, `sizeBytes`, `durationSeconds`, `width`, `height`, `codec`, `streamUrl`, `downloadUrl`, `thumbnailUrl`, `createdAt`).

**Error responses:**
- `404 VIDEO_NOT_FOUND`: no video with `shortCode`, or the video is not `ready` (_Revised 2026-11-20 (final review)_: was `409 VIDEO_NOT_READY`, which confirmed that an unpublished shortCode exists)

---

#### GET /videos/:shortCode/stream (SI-03.8, SI-03.9)

**Request headers:**
- `Range`: optional string (`bytes=start-end`, e.g., `bytes=0-1048575`)

**Response 206 (with `Range` header) / 200 (without `Range` header):**
- Binary video stream piped directly from S3/MinIO
- Response headers: `Accept-Ranges: bytes`, `Content-Type`, `Content-Length`, `ETag`, `Cache-Control: no-cache`, and on `206`: `Content-Range: bytes start-end/total`
- `HEAD` returns the same headers without reading storage; `If-None-Match` matching the `ETag` returns `304` (_Revised 2026-11-20 (final review)_)
- Conditionals are evaluated before `Range` (RFC 9110): matching `If-None-Match` → `304` even with an unsatisfiable `Range`; `If-Range` that is not the current strong `ETag` → full `200`; `HEAD`, unknown units and multiple ranges get the full representation (`200`) (_Revised 2026-11-20 (round 5)_)

**Error responses:**
- `404 VIDEO_NOT_FOUND` (also when not `ready`)
- `416 INVALID_RANGE`: malformed or out-of-bounds `Range` header; carries `Content-Range: bytes */total` (_Revised 2026-11-20 (final review)_)

---

#### GET /videos/:shortCode/download (SI-03.8, SI-03.9)

**Response 200:**
- Binary video stream piped from S3/MinIO
- Response headers: `Content-Type`, `Content-Length`, `ETag`, `Cache-Control: no-cache`, `Content-Disposition: attachment; filename="<ASCII fallback>"; filename*=UTF-8''<encoded original>` (RFC 6266; _Revised 2026-11-20 (final review)_: a raw non-Latin-1 name made Node reject the header with 500)
- `HEAD` / `304` as in `/stream`

**Error responses:**
- `404 VIDEO_NOT_FOUND` (also when not `ready`)

---

#### GET /videos/:shortCode/thumbnail (SI-03.8, SI-03.9)

**Response 200:**
- JPEG image stream piped from S3/MinIO (`Content-Type: image/jpeg`, `Content-Length`, `ETag`, `Cache-Control: no-cache`; `HEAD` / `304` as in `/stream`)

**Error responses:**
- `404 VIDEO_NOT_FOUND` (also when not `ready`)

---

### Authorization Matrix

| Endpoint | Anonymous | Authenticated | Owner (Channel) | Notes |
|---|---|---|---|---|
| `POST /videos/uploads/initiate` | ✗ | ✓ | ✓ | Creates draft under caller's channel |
| `POST /videos/:id/uploads/parts` | ✗ | ✓ | ✓ | Must own video's channel |
| `POST /videos/:id/uploads/complete` | ✗ | ✓ | ✓ | Must own video's channel |
| `POST /videos/:id/uploads/abort` | ✗ | ✓ | ✓ | Must own video's channel |
| `GET /videos/:id/uploads/parts` | ✗ | ✓ | ✓ | Must own video's channel; draft only |
| `GET /videos/me` | ✗ | ✓ | ✓ | Lists caller's channel videos |
| `GET /videos/:id/status` | ✗ | ✓ | ✓ | Owner-only status/error inspection |
| `GET /videos/:shortCode` | ✓ | ✓ | ✓ | `@Public()`, requires `status === 'ready'` |
| `GET /videos/:shortCode/stream` | ✓ | ✓ | ✓ | `@Public()`, requires `status === 'ready'` |
| `GET /videos/:shortCode/download` | ✓ | ✓ | ✓ | `@Public()`, requires `status === 'ready'` |
| `GET /videos/:shortCode/thumbnail` | ✓ | ✓ | ✓ | `@Public()`, requires `status === 'ready'` |

---

### Error Catalog

Inherits standard error envelope from `phase-02-auth/TD-07`: `{ statusCode: number, error: string, message: string | string[] }`.

| `errorCode` | HTTP | Trigger |
|---|---|---|
| `CHANNEL_NOT_FOUND` | 404 | Authenticated user has no channel record |
| `VIDEO_NOT_FOUND` | 404 | Video `id` or `shortCode` does not exist, or a public route asks for a video that is not `ready` (_Revised 2026-11-20 (final review)_: replaces `409 VIDEO_NOT_READY`) |
| `VIDEO_ACCESS_DENIED` | 403 | Authenticated user attempts to sign/complete/abort/inspect a video owned by another channel |
| `VIDEO_INVALID_STATE` | 409 | Upload part/complete/abort requested on a video not in `draft` status |
| `TOO_MANY_OPEN_UPLOADS` | 409 | Initiate while the channel already holds `VIDEO_MAX_OPEN_DRAFTS` (5) drafts |
| `UPLOAD_LIMIT_EXCEEDED` | 413 | Declared `sizeBytes` or actual S3 `HeadObject` size exceeds `10737418240` bytes (10 GiB) |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | `mimeType` not in `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska` |
| `INVALID_UPLOAD_PARTS` | 400 | Duplicate or S3-rejected multipart upload parts on complete (empty lists fail validation; unsorted lists are sorted, not rejected) |
| `INVALID_RANGE` | 416 | Malformed or unsatisfiable HTTP `Range` header on `/stream` (response carries `Content-Range: bytes */size`) |
| _(throttler)_ | 429 | More than 10 `POST /videos/uploads/initiate` per minute |

---

### Events/Messages

#### `process-video` (queue: `video-processing`)

**Payload:**

```json
{
  "videoId": "uuid",
  "channelId": "uuid",
  "storageKey": "videos/{channelId}/{videoId}/original.mp4",
  "mimeType": "video/mp4"
}
```

**Producer:** `VideosQueueService` inside `nestjs-api` (`POST /videos/:id/uploads/complete`) (per `phase-03-videos/TD-01`, `TD-04`)
**Consumer:** `VideoProcessingProcessor` inside `video-worker` (`@Processor('video-processing')`) (per `phase-03-videos/TD-01`, `TD-05`)
**Trigger:** Upload completion claims the video atomically (`draft` → `processing`), then the API assembles the S3 multipart upload, verifies `HeadObject` and enqueues the job; a `HeadObject` or enqueue failure marks the video `failed`.
**Delivery semantics:** At-least-once with deterministic `jobId: process-video-${videoId}`, `attempts: 3`, exponential backoff (`delay: 2000ms`), and `@OnWorkerEvent('failed')` terminal state transition to `failed` once retries exhaust (per `phase-03-videos/TD-01`, `TD-04`).

---

## Dependency Map

```
SI-03.1 (Deps, Config, Env, Compose: MinIO + Redis + Worker)
├── SI-03.2 (Video Entity + Channel findByUserId + Migration)
├── SI-03.3 (Domain Exceptions + S3StorageService)
└── SI-03.4 (BullMQ Config + VideosQueueService)

SI-03.2 + SI-03.3 + SI-03.4
├── SI-03.5 (ShortCode Util + Upload Initiate)
│   └── SI-03.6 (Sign Part + Complete + Abort)
├── SI-03.7 (MediaProcessorService + VideoProcessingProcessor + Worker Main)
└── SI-03.8 (VideosService: Query + Range Stream + Download + Thumbnail)

SI-03.6 + SI-03.7 + SI-03.8
└── SI-03.9 (VideosController + VideosModule + OpenAPI Export)
    └── SI-03.10 (E2E Full Video Lifecycle Tests)
        └── SI-03.11 (Docs + Software Arch Diagram + Progress + DoD)
```

Linearized implementation order: `SI-03.1` → `SI-03.2`, `SI-03.3`, `SI-03.4` → `SI-03.5` → `SI-03.6` → `SI-03.7`, `SI-03.8` → `SI-03.9` → `SI-03.10` → `SI-03.11`.

---

## Deliverables

- [x] `technical-decisions-phase-03-videos.md` (`status: decided`) and `docs/phases/phase-03-videos/` (`context.md`, `validation.md` `clean`, `library-refs.md`, `phase-03-videos.md`, `progress.md`)
- [x] `minio`, `redis`, and `video-worker` services running cleanly in `nestjs-project/compose.yaml` (using service-name networking)
- [x] TypeORM migration creating `videos` table linked to `channels` (`npm run migration:run` + bidirectional migration test green)
- [x] Multipart presigned upload supporting up to 10 GiB without buffering bytes in API, creating `draft` record at initiation
- [x] Dedicated `video-worker` extracting `durationSeconds`, `width`, `height`, `codec`, generating JPEG thumbnail via `ffmpeg`/`ffprobe`, and updating `ready` / `failed`
- [x] Conflict-free 11-character `short_code` unique URLs
- [x] HTTP Byte-Range `206 Partial Content` streaming, attachment download, and JPEG thumbnail endpoints (`@Public()` when `ready`)
- [x] OpenAPI spec updated (`nestjs-project/openapi.json`)
- [x] Unit + real-infra integration (`npm test -- --runInBand`) and E2E (`npm run test:e2e`) passing inside container
- [x] `npx tsc --noEmit` exits 0, `npm run lint` passes, `npm run build` succeeds inside container
- [x] `CLAUDE.md`, `GEMINI.md`, `nestjs-project/CLAUDE.md`, `nestjs-project/GEMINI.md`, `docs/diagrams/software-arch.mermaid`, and `README.md` updated and consistent with code
- [x] Git Flow respected (`feature/phase-03-videos` from `dev` → `dev` → `main` via merge, zero direct commits on `main`)
