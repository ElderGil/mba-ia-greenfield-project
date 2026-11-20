---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-16
scope_description: "Phase 03 backend video architecture: message queue, 10GB multipart upload, S3/MinIO storage layout, video draft/processing lifecycle, FFmpeg worker runtime, unique short URLs, and HTTP Range streaming/download."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — backend API, database migration (`videos`), Docker Compose infrastructure (`minio`, `redis`, `video-worker`), S3 upload/streaming integration, and FFmpeg worker.
- `next-frontend/` — Frontend out of scope for Phase 03 (per challenge scope; video upload/player UI screens will be implemented in later phases — no frontend-only decision in this document, though cross-layer upload/URL/streaming contracts constrain future frontend integration).

---

## TD-01: Message Queue Technology & NestJS Integration

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** Video metadata extraction and thumbnail generation are CPU/IO-intensive operations that must run asynchronously in the background after upload completion (`docs/project-plan.md`, `docs/diagrams/software-arch.mermaid`). The queue choice is explicitly marked `TBD` in `CLAUDE.md` and `software-arch.mermaid`, making it the primary open stack decision for Phase 03. Must run inside Docker Compose and integrate cleanly with NestJS 11 (`@nestjs/core ^11.0.1`).

**Options:**

### Option A: BullMQ (`@nestjs/bullmq` + `bullmq` + Redis)
- Redis-backed distributed job queue using the official `@nestjs/bullmq` (`11.0.5`, NestJS 11 support, CommonJS) and `bullmq` (`6.7.6`) packages. Jobs are persisted in Redis, processed by a dedicated worker consumer, and support exponential backoff retries, concurrency limits, and job failure hooks out of the box.
- **Pros:** First-class official NestJS integration (`BullModule.forRootAsync`, `@Processor`, `@InjectQueue`), built-in retry/backoff and failed-job retention, clean isolation from PostgreSQL, simple single-container Redis dependency in Docker Compose.
- **Cons:** Introduces Redis as a new infrastructure service in `compose.yaml` (extra container and env vars).

### Option B: pg-boss (PostgreSQL-backed Queue)
- Uses the existing PostgreSQL 17 database (`SELECT ... FOR UPDATE SKIP LOCKED`) to store and poll jobs without adding a Redis container.
- **Pros:** Zero new broker container in Docker Compose; transactional enqueue alongside DB updates.
- **Cons:** No official NestJS 11 module (requires custom lifecycle/DI wiring), adds polling queries and table bloat/vacuum pressure to the primary relational database, weaker ecosystem tooling for stalled-job recovery and worker concurrency compared to BullMQ.

### Option C: RabbitMQ (`amqplib` / `@nestjs/microservices`)
- AMQP message broker with exchanges, bindings, and dead-letter queues.
- **Pros:** Strong routing semantics and protocol-level acknowledgments; suitable for polyglot microservice architectures.
- **Cons:** Higher operational/RAM footprint in local Docker Compose; retry with exponential backoff and dead-letter topologies require manual exchange/TTL plumbing whereas BullMQ provides them declaratively.

**Recommendation:** **Option A (BullMQ + Redis)** — `@nestjs/bullmq` officially supports NestJS 11, provides declarative retries/backoff and stalled-job handling, and keeps background job polling off PostgreSQL with a lightweight `redis:7-alpine` container.

**Decision:** A (BullMQ + Redis via `@nestjs/bullmq`, `bullmq`, `ioredis`)

> **Revision (2026-11-17, peer review):** the version actually pinned is `@nestjs/bullmq@^11.0.5`, not `12.0.2`. `12.x` ships ESM-only and breaks Jest in this CommonJS project (recorded in `phase-03-videos/progress.md`, SI-03.1). `11.0.5` declares `@nestjs/core ^10 || ^11` and `bullmq ^3 || ^4 || ^5 || ^6` as peers, so the decision (BullMQ + Redis) stands; only the version line changed. `ioredis` is `^5.11.1`.

**Libraries:** @nestjs/bullmq, bullmq, ioredis

---

## TD-02: Large Video Upload Strategy (up to 10GB)

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** Phase 03 requires uploading video files up to 10GB without blocking or crashing the NestJS API and supporting connection-drop recovery (`docs/project-plan.md` §4). Because the upload handshake defines both API endpoints and how clients (future `next-frontend/` or API clients) transmit bytes, this is a cross-layer contract.

**Options:**

### Option A: S3 Multipart Upload with Presigned Part URLs (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)
- Three-step handshake: (1) client calls `POST /videos/uploads/initiate` → API creates a `draft` video record, calls S3 `CreateMultipartUpload`, and returns `{ videoId, shortCode, uploadId, partSizeBytes }`; (2) client requests presigned `UploadPart` URLs (`POST /videos/:id/uploads/parts`) and `PUT`s chunks (e.g., 5MB–100MB each) directly to MinIO/S3, retrying individual failed parts on network drops; (3) client calls `POST /videos/:id/uploads/complete` with `{ parts: [{ partNumber, etag }] }` (_revised 2026-11-20: the API already holds the `uploadId`; the DTO rejects unknown fields, so sending it is a 400_) → API verifies parts/object and enqueues processing. Also supports aborting (`POST /videos/:id/uploads/abort`).
- **Pros:** Zero video bytes flow through NestJS/Node memory or Express request timeouts; supports up to 5TB (10,000 parts × up to 5GB); natively resumable per part; native S3/MinIO feature requiring no extra upload server.
- **Cons:** Client must split files into chunks ≥ 5MB (except final part) and collect `ETag` headers; requires MinIO CORS configuration when browser clients upload directly.

### Option B: Single Presigned PUT URL
- API issues one presigned `PutObjectCommand` URL and the client uploads the entire file in a single HTTP `PUT` directly to S3/MinIO.
- **Pros:** Simpler client flow (single request after initiation).
- **Cons:** S3/MinIO single `PUT` object size limit is **5GB**, which fails the **10GB** requirement; a network drop at 9GB forces restarting from byte 0.

### Option C: tus Resumable Upload Protocol (`tusd` or `@tus/server`)
- Dedicated tus server or NestJS tus middleware receiving chunked PATCH requests and forwarding/storing to S3.
- **Pros:** Standardized resumable protocol with offset tracking.
- **Cons:** Running `@tus/server` inside NestJS still routes 10GB of traffic through the API container; running standalone `tusd` adds another container and auth-hook coupling when S3/MinIO already provides native multipart uploads.

**Recommendation:** **Option A (S3 Multipart Upload with Presigned Part URLs)** — Single `PUT` caps at 5GB and cannot meet the 10GB requirement; S3 multipart keeps 100% of binary upload traffic off the NestJS API and supports per-part resume without extra server containers.

**Decision:** A (S3 Multipart Upload with Presigned Part URLs; max 10 GiB / 10,737,418,240 bytes, default 10 MiB part size, allowed MIME types `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`)

> **Revision (2026-11-17, peer review):** presigned part URLs embed the host they were signed for, the same SigV4 constraint that rules out presigned GET in TD-07. The API signs part URLs with a dedicated client bound to `S3_PUBLIC_ENDPOINT` (falls back to `S3_ENDPOINT`, i.e. `minio:9000`, which only resolves inside the Compose network). Clients on the host need `S3_PUBLIC_ENDPOINT=http://localhost:9000`; the test suites run inside the `nestjs-api` container and need it empty. In production it is the public S3 endpoint, and browser uploads additionally need bucket CORS exposing `ETag` (out of scope while the upload UI is not built).

> **Revision (2026-11-20, final review):** same decision, three parameters added. (1) Resume: `GET /videos/:id/uploads/parts` returns the parts already stored (S3 `ListParts`), so a client that lost its ETags can finish the upload (`project-plan.md` §4). (2) Limits: `POST /videos/uploads/initiate` is throttled (10/min) and a channel may hold `VIDEO_MAX_OPEN_DRAFTS` (5) open drafts (`409 TOO_MANY_OPEN_UPLOADS`), because each open draft holds a multipart upload. (3) Complete accepts up to 10 000 parts (JSON body limit 1 MB). Presigned part URLs are signed without a checksum (`requestChecksumCalculation: WHEN_REQUIRED`), which real S3 requires.

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-03: Object Storage Client SDK & Bucket/Key Organization

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** Object storage is already defined as S3-compatible (MinIO locally in Docker Compose, AWS S3 in production). The open backend choice is which Node.js SDK to use and how buckets, access policies, and object keys are structured so videos and thumbnails remain isolated, conflict-free, and protected by API authorization.

**Options:**

### Option A: AWS SDK v3 (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) with Private Bucket and Prefix Isolation
- Uses modular AWS SDK v3 (`^3.1170.0`, the version installed since SI-03.1; this line said `3.1169.0`) configured with `endpoint`, `region`, `credentials`, and `forcePathStyle: true` (env-driven so MinIO works locally and AWS S3 works in production). Single private bucket (e.g. `streamtube-media`) with deterministic prefixes: `videos/{channelId}/{videoId}/original` (or `.ext`) and `thumbnails/{channelId}/{videoId}/thumb.jpg`.
- **Pros:** Standard TypeScript-first modular SDK, works identically with MinIO and AWS S3, private bucket prevents bypassing API status/ownership/visibility checks (critical for `draft` and future `unlisted` videos), single bucket simplifies IAM/Compose bootstrap.
- **Cons:** Requires `forcePathStyle: true` configuration for MinIO and explicit bucket initialization on Compose startup.

### Option B: Official `minio` JS Client with Separate Public/Private Buckets
- Uses `minio` npm client and exposes a public bucket for thumbnails/videos.
- **Pros:** MinIO-oriented helper APIs (e.g., `bucketExists`/`makeBucket`).
- **Cons:** Couples application code to a MinIO-specific SDK instead of standard AWS SDK v3; public bucket URLs bypass API access control for `draft` or `failed` videos.

**Recommendation:** **Option A (AWS SDK v3 + Private Bucket with Prefix Isolation)** — Vendor-neutral S3 compatibility between local MinIO and production S3, first-class support for `CreateMultipartUpload`/`UploadPart`/`CompleteMultipartUpload`/`GetObject` (`Range`), and private storage enforced by the API.

**Decision:** A (AWS SDK v3 + private bucket `streamtube-media` with structured key prefixes)

**Libraries:** @aws-sdk/client-s3, @aws-sdk/s3-request-presigner

---

## TD-04: Video Draft Lifecycle, Status Machine & Failure Handling

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)"

**Context:** `project-plan.md` requires pre-registering the video as a draft (`rascunho`) when upload starts, then automatically processing it once uploaded. The state machine must handle upload completion verification, concurrent/duplicate complete calls, and worker failures cleanly without leaving stale `processing` records.

**Options:**

### Option A: 4-State Lifecycle (`draft` → `processing` → `ready` | `failed`)
- `POST /videos/uploads/initiate` persists the `Video` entity owned by the authenticated user's channel with `status = 'draft'` and a unique `shortCode`.
- `POST /videos/:id/uploads/complete` first claims the row with a conditional `UPDATE ... SET status = 'processing' WHERE id = :id AND status = 'draft'` (the claim is the lock against concurrent completes: the loser gets `409` and never touches S3), then completes the S3 multipart upload, verifies object metadata (`HeadObject`), and enqueues the BullMQ `process-video` job. If S3 rejects the parts the row goes back to `draft` (the multipart upload is still open, so the client can retry); once S3 has closed the multipart upload, a failed `HeadObject`, an oversized object or a failed enqueue moves the row to `failed` with `processingError` instead of leaving it in `processing` without a job.
- The worker updates metadata + `thumbnailKey` and sets `status = 'ready'` on success; if retries exhaust (or media is invalid/corrupt), a failure handler records `status = 'failed'` and `processingError`. Failed or aborted uploads can re-initiate or remain inspectable via status endpoint.
- **Pros:** Matches `project-plan.md` terminology (`draft` / rascunho) and Phase 04's publishing workflow; prevents duplicate job enqueue via conditional state check; surfaces explicit `failed` state with error reason.
- **Cons:** Does not separate "upload started" from "draft metadata edited before upload" (both are `draft` until `complete` is called, which is sufficient for Phase 03).

### Option B: 6-State Lifecycle (`initiated` → `uploading` → `uploaded` → `processing` → `ready` | `failed`)
- Tracks granular upload sub-states in PostgreSQL on every part signature request.
- **Pros:** Slightly more granular telemetry during upload.
- **Cons:** Unnecessary DB writes on every chunk sign request and diverges from `project-plan.md`'s explicit "rascunho" (`draft`) initial state.

**Recommendation:** **Option A (`draft` → `processing` → `ready` | `failed`)** — Directly matches `project-plan.md`, supports atomic `draft → processing` transition on upload completion, and cleanly represents terminal processing failures.

**Decision:** A (4-state lifecycle: `draft` → `processing` → `ready` | `failed`)

> **Revision (2026-11-20, final review):** same lifecycle; the states that had no way out now have one. A maintenance sweep in the worker (BullMQ job scheduler, every 15 min) deletes drafts older than `VIDEO_DRAFT_TTL_HOURS` (24) after aborting their multipart upload, and moves to `failed` the `processing` videos idle for `VIDEO_PROCESSING_STUCK_MINUTES` (30) that have no live job (API stopped between claim and enqueue, job lost). A job BullMQ fails with `UnrecoverableError` (stalled past `maxStalledCount`) is final even with attempts left.

**Libraries:** —

---

## TD-05: Video Worker Runtime Topology & FFmpeg Execution Strategy

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Processing uploaded videos requires probing duration/resolution/codec metadata (`ffprobe`) and extracting a representative thumbnail frame (`ffmpeg`). Because videos can be up to 10GB, both process isolation and how FFmpeg reads media and avoids deprecated libraries are critical.

**Options:**

### Option A: Dedicated `video-worker` Docker Service + Native `ffmpeg`/`ffprobe` via `child_process`
- `compose.yaml` defines a dedicated `video-worker` container (built with `ffmpeg` installed via `apt-get`, running a separate NestJS standalone application context `worker.main.ts` that registers the BullMQ `@Processor`).
- Uses a small typed Promise wrapper around Node `child_process.execFile`/`spawn` invoking `ffprobe -v quiet -print_format json -show_format -show_streams` and `ffmpeg` directly — reading from a presigned S3 GET URL (HTTP range requests, avoiding downloading 10GB to disk when seeking/probing) or streaming to `/tmp` if container format requires seekable input, and uploading the generated JPEG thumbnail back to S3.
- **Pros:** Matches C4 container diagram (`Video Worker` separated from `API`); keeps heavy CPU/memory FFmpeg processes isolated from API HTTP latency; avoids `fluent-ffmpeg` (officially archived/deprecated); full control over FFmpeg flags, timeouts, and stderr diagnostics.
- **Cons:** Requires a second entrypoint/container definition in `compose.yaml` and explicit graceful shutdown on `SIGTERM`.

### Option B: In-Process Worker inside `nestjs-api` using `fluent-ffmpeg`
- Runs the BullMQ consumer inside the API container and wraps FFmpeg calls with `fluent-ffmpeg`.
- **Pros:** Only one Node container in `compose.yaml`.
- **Cons:** Violates the C4 container separation (`API` vs `Video Worker`); FFmpeg CPU/RAM spikes can starve API HTTP requests; `fluent-ffmpeg` is archived and unmaintained against modern FFmpeg 6/7.

### Option C: Dedicated `video-worker` using `ffmpeg.wasm`
- Executes FFmpeg compiled to WebAssembly inside Node.
- **Pros:** No OS `ffmpeg` package needed in Dockerfile.
- **Cons:** Much slower CPU execution and WASM memory limits make it unsuitable for large (up to 10GB) video files.

**Recommendation:** **Option A (Dedicated `video-worker` Container + Native `ffmpeg`/`ffprobe` via `child_process`)** — Matches the target C4 architecture, avoids deprecated `fluent-ffmpeg`, and keeps API responsiveness isolated from FFmpeg workloads.

**Decision:** A (Dedicated `video-worker` container + native `ffmpeg`/`ffprobe` via `child_process`, extracting `durationSeconds`, `width`, `height`, `codec`, and JPEG thumbnail at 1s with 0s fallback; _revised 2026-11-20: `sizeBytes` comes from the API's `HeadObject` and `mimeType` from initiate, the worker extracts neither; the thumbnail seek is `min(1s, duration/2)` with first-frame fallback, and the demuxer is forced from the stored MIME_)

> **Revision (2026-11-20, final review):** same topology. ffprobe/ffmpeg run with the demuxer forced from the stored MIME (`mov` for mp4/quicktime, `matroska` for webm/mkv) and a protocol whitelist, so images are rejected and a playlist disguised as video cannot make the worker fetch URLs (SSRF). The thumbnail is taken at `min(1s, duration/2)` with a first-frame fallback (a 1.0 s clip has no frame at 1 s). Errors are stored as `"<tool> failed: <stderr>"` with URLs redacted. The container runs `node` directly so SIGTERM reaches Nest and BullMQ drains the active job.

**Libraries:** —

---

## TD-06: Unique Video URL Identifier Strategy

**Scope:** Cross-layer

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** `project-plan.md` (§3 and §4) requires a short, unique URL identifier per video that never conflicts with other videos. Internal PostgreSQL PKs are UUID v4 (36 chars), which are unnecessarily long for shareable watch/stream URLs.

**Options:**

### Option A: 11-Character URL-Safe Random Short Code (`crypto.randomBytes(8).toString('base64url')` + DB `UNIQUE` Constraint)
- Generates an 11-character URL-safe string (`[A-Za-z0-9_-]`, 64 bits of entropy) stored in `videos.short_code` with a PostgreSQL `UNIQUE` index, wrapped in a bounded collision-retry loop on insert (catching Postgres `23505` on `short_code`).
- **Pros:** Short YouTube-style URLs (`/videos/:shortCode/stream`), non-enumerable, zero external packages (avoids `nanoid` v6 ESM-only friction in CommonJS NestJS), conflict-free guaranteed at the database constraint level.
- **Cons:** Requires a small retry helper on unique-violation during insert (probability < $10^{-11}$ even at millions of rows).

### Option B: Expose UUID v4 Directly in Public Video URLs
- Uses the primary key `id` (UUID) as the URL identifier.
- **Pros:** Zero extra column or generator.
- **Cons:** 36 characters long — contradicts `project-plan.md` §4 ("URL curta e única").

### Option C: `nanoid` Package (`nanoid@6.x`)
- Uses `nanoid` library for random URL-safe IDs.
- **Pros:** Popular short-ID utility.
- **Cons:** `nanoid` v4–v6 is pure ESM (`"type": "module"`), which adds module-interop friction with NestJS's CommonJS compilation/Jest `ts-jest` pipeline when Node's built-in `crypto.randomBytes().toString('base64url')` provides identical entropy and alphabet natively.

**Recommendation:** **Option A (11-char `crypto.randomBytes(8).toString('base64url')` + DB `UNIQUE` constraint)** — Short, non-enumerable, native to Node 25 with zero ESM/CommonJS friction, and strictly conflict-free via PostgreSQL `UNIQUE` constraint + retry.

**Decision:** A (11-char `crypto.randomBytes(8).toString('base64url')` + DB `UNIQUE` index with collision retry)

**Libraries:** —

---

## TD-07: Video Streaming & Download Delivery Strategy

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Users must be able to watch videos via streaming (starting playback and seeking immediately without downloading the full file) and download the full video file. Because `next-frontend/` and test clients interact with these endpoints, delivery semantics (headers, status codes, endpoint contract) are cross-layer.

**Options:**

### Option A: API Byte-Range Streaming Proxy (`206 Partial Content`) & Attachment Download Endpoint
- `GET /videos/:shortCode/stream` parses the HTTP `Range` header (`bytes=start-end`), inspects `contentLength` / `contentType` (from DB/S3 `HeadObject`), requests only that byte slice via S3 `GetObjectCommand({ Bucket, Key, Range })`, and pipes the Node `Readable` stream directly to the HTTP response with `206 Partial Content`, `Accept-Ranges: bytes`, `Content-Range`, `Content-Length`, and `Content-Type` (or `200 OK` full stream when no `Range` header is sent, bounded or streamed without buffering).
- `GET /videos/:shortCode/download` streams the S3 object with `Content-Disposition: attachment; filename="..."` and `Content-Length`.
- Both endpoints verify `video.status === 'ready'` (returning domain error `404 VIDEO_NOT_FOUND` otherwise — _revised 2026-11-20: was `409 VIDEO_NOT_READY`, which confirmed that an unpublished shortCode exists_ — and leaving future visibility checks in Phase 04/05 cleanly gated in the API).
- **Pros:** Zero full-file memory buffering (streams chunk-by-chunk from S3); works seamlessly inside Docker Compose without MinIO internal (`minio:9000`) vs host (`localhost:9000`) presigned `Host`-header signature mismatches; directly verifiable via HTTP `Range` assertions (`206`) in E2E tests; centralizes authorization and view-count hooks for Phases 04–05.
- **Cons:** Video playback bytes traverse the NestJS API process (acceptable for Node streams, and can be switched to CDN/signed URLs in production later without changing the route contract).

### Option B: HTTP 302 Redirect to S3 Presigned GET URL
- API returns `302 Found` with `Location` pointing to a presigned MinIO/S3 URL.
- **Pros:** Offloads streaming bandwidth directly to S3/MinIO.
- **Cons:** Breaks in local Docker/browser environments because the API signs against `minio:9000` (internal Docker DNS) while external clients/browsers reach `localhost:9000`, invalidating AWS SigV4 `Host` signatures unless a dual-endpoint/reverse-proxy setup is introduced; also prevents straightforward E2E body/header assertions on `GET /videos/:shortCode/stream` without external redirects.

### Option C: Full HLS Transcoding Pipeline (`.m3u8` + `.ts` Segments)
- Worker transcodes every uploaded video into HLS segments during Phase 03.
- **Pros:** Adaptive bitrate streaming in production.
- **Cons:** Transcoding up to 10GB videos in the worker multiplies processing time, disk I/O, and storage footprint disproportionately for Phase 03, which specifies duration/metadata extraction, thumbnail generation, and streaming without full download (fully satisfied by HTTP Byte-Range `206`).

**Recommendation:** **Option A (API Byte-Range `206 Partial Content` Stream Proxy + `Content-Disposition: attachment` Download)** — Delivers true seekable streaming without full-file download or memory buffering, avoids MinIO Docker/host SigV4 host-mismatch issues, enforces domain status/access rules in the API, and keeps the route contract clean for Phase 05's video player.

**Decision:** A (API Byte-Range `206` stream proxy + attachment download; `@Public()` playback/thumbnail/download when `status === 'ready'`, JWT + channel ownership for upload/status/management)

> **Revision (2026-11-20, final review):** same delivery strategy. Public routes answer `404` for videos that are not `ready` (was `409`). Media responses answer `HEAD` without reading storage, send a strong `ETag` with `Cache-Control: no-cache` and `304` on `If-None-Match`, put `Content-Range: bytes */size` on `416`, and use an RFC 6266 `Content-Disposition` (ASCII fallback + UTF-8 `filename*`). Storage streams are opened lazily and piped with `pipeline()`.

**Libraries:** @aws-sdk/client-s3

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology & NestJS Integration | Option A (BullMQ + Redis) | A |
| TD-02 | Cross-layer | Large Video Upload Strategy (up to 10GB) | Option A (S3 Multipart Upload via Presigned URLs) | A |
| TD-03 | Backend | Object Storage Client SDK & Bucket/Key Layout | Option A (AWS SDK v3 + Private Bucket with Prefixes) | A |
| TD-04 | Backend | Video Draft Lifecycle, Status Machine & Failure Handling | Option A (`draft` → `processing` → `ready` \| `failed`) | A |
| TD-05 | Backend | Video Worker Runtime Topology & FFmpeg Execution | Option A (Dedicated `video-worker` + native `ffmpeg`/`ffprobe`) | A |
| TD-06 | Cross-layer | Unique Video URL Identifier Strategy | Option A (11-char `crypto.randomBytes(8).toString('base64url')` + UNIQUE) | A |
| TD-07 | Cross-layer | Video Streaming & Download Delivery Strategy | Option A (API HTTP Range `206` Stream Proxy + Attachment Download) | A |
