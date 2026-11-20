# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `video-worker` — NestJS standalone BullMQ worker (`src/worker.main.ts` / `WorkerModule`) with FFmpeg/ffprobe; also runs the maintenance sweep. Runs `node` directly (no `npm run`) so `docker compose stop` delivers SIGTERM to Nest
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — Mailpit SMTP `1025`, Web UI `8025`
- `minio` — S3-compatible object storage (`pgsty/silo`), API port `9000`, Console port `9001`
- `redis` — Redis 7 (BullMQ queue backend), port `6379`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build
npm run start:worker:dev                 # Run BullMQ FFmpeg video worker (dev)
npm run start:worker                     # Run compiled BullMQ FFmpeg video worker

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (serial: maxWorkers 1)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share one test database (`streamtube_test`), so they must run serially. Both Jest configs set `maxWorkers: 1`, so the plain commands are already serial (`--runInBand` is equivalent):

```bash
docker compose exec nestjs-api npm test
docker compose exec nestjs-api npm run test:e2e
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently (reproduced with `--maxWorkers=4`: 8 unit/integration and 5 e2e failures).

Tests never touch the development data:

- `src/test/test-env.ts` rewrites `DB_NAME` to `<DB_NAME>_test` and `S3_BUCKET` to `<S3_BUCKET>-test`, and forces the BullMQ prefix `streamtube-test`, so the compose `video-worker` never picks up test jobs and `queue.obliterate()` never touches real ones.
- `src/test/global-setup.ts` (Jest `globalSetup`) creates the test database when missing and migrates it with the CLI DataSource (`src/database/data-source.ts`): the schema comes from the migrations, never from `synchronize`.
- `cleanAllTables()` and the migrations spec refuse to run on a database whose name does not end in `_test`.

The video suites need the `minio`, `redis` and `video-worker`-image tooling (`ffmpeg`/`ffprobe`, installed by `Dockerfile.dev`) in addition to `db`.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config", ".../src/test/test-env.ts"]` — without `dotenv/config`, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS. `test-env.ts` points the run at the test database, bucket and BullMQ prefix.
- `maxWorkers: 1` — keeps the suites serial (see "Test execution").
- `globalSetup` (`src/test/global-setup.ts`) — creates and migrates the test database before any suite runs.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (`AuthModule`, `UsersModule`, `ChannelsModule`, `MailModule`, `StorageModule`, `VideosModule`). `AppModule` imports `AuthModule` (which brings `UsersModule` → `ChannelsModule`, and `MailModule`) and `VideosModule` (which brings `ChannelsModule` and `StorageModule`), plus the root `TypeOrmModule`, `BullModule` and `ConfigModule`
- `WorkerModule` (`src/worker.main.ts`) runs the standalone BullMQ consumers in the `video-worker` container: `VideoProcessingProcessor` + `MediaProcessorService` (`ffmpeg`/`ffprobe`) and `VideoMaintenanceProcessor` + `VideoMaintenanceService` (sweep)
- `StorageModule` (`S3StorageService`) wraps `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` for MinIO/S3 multipart uploads, presigned URLs, and byte-range streaming
- Controllers handle HTTP routing (`VideosController`, `AuthController`); Services hold business logic; both are scoped to their module

## Videos (Phase 03)

Module `src/videos/` (+ `src/storage/`, worker in `src/worker.module.ts`). Decisions: `docs/decisions/technical-decisions-phase-03-videos.md`; plan and progress: `docs/phases/phase-03-videos/`.

### Endpoints (`VideosController`, `/videos`)

| Route | Auth | Purpose |
|---|---|---|
| `POST /videos/uploads/initiate` | JWT, throttled 10/min | Creates the `draft` row (unique 11-char `shortCode`) and the S3 multipart upload. `409 TOO_MANY_OPEN_UPLOADS` past `VIDEO_MAX_OPEN_DRAFTS` |
| `POST /videos/:id/uploads/parts` | owner, draft | Presigned `PUT` URL for one part (the client uploads straight to storage) |
| `GET /videos/:id/uploads/parts` | owner, draft | Parts already stored, with ETags, to resume an upload |
| `POST /videos/:id/uploads/complete` | owner, draft | `202`: claims draft → processing (conditional UPDATE, loser gets `409`), completes S3, checks size, enqueues the job |
| `POST /videos/:id/uploads/abort` | owner, draft | `204`: claims the draft, aborts the multipart upload and deletes the draft; `409` if a complete claimed it first |
| `GET /videos/me` | JWT | Videos of the caller's channel, any status |
| `GET /videos/:id/status` | owner | Status, extracted metadata, `processingError`, `thumbnailUrl` |
| `GET /videos/:shortCode` | public | Metadata + stream/download/thumbnail URLs |
| `GET /videos/:shortCode/stream` | public | `200`, or `206` for a single byte `Range` on `GET`; `416` carries `Content-Range: bytes */size`. Conditionals come first (`selectRange()`): matching `If-None-Match` → `304`, `If-Range` ≠ current ETag → full `200`; `HEAD`, unknown units and multiple ranges → full representation |
| `GET /videos/:shortCode/download` | public | Full file, RFC 6266 `Content-Disposition` (ASCII `filename` + UTF-8 `filename*`) |
| `GET /videos/:shortCode/thumbnail` | public | JPEG thumbnail |

Public routes answer `404 VIDEO_NOT_FOUND` for anything not `ready`, so a shortCode never reveals an unpublished video. Media routes answer `HEAD` without opening storage, send a strong `ETag` + `Cache-Control: no-cache` and answer `304` to `If-None-Match`. All media bodies go through `sendMedia()` (`videos-http.util.ts`): storage is opened lazily, destroyed if the client leaves, and piped with `pipeline()`.

### Lifecycle and processing

- Status: `draft` → `processing` → `ready` | `failed` (`VideoStatus`, Postgres enum). A rejected part list returns the row to `draft`; after S3 closes the multipart upload, any failure (HeadObject, oversize, enqueue) ends in `failed` with `processing_error`.
- One claim rule for leaving a draft (`video-upload-session.ts`): complete, abort and the sweep all claim the row with a conditional UPDATE on `(id, draft, upload_id)` (`draftUploadClaim`) before any destructive S3 call, so exactly one of them owns the upload. A discard detaches `upload_id`, aborts, then deletes; if the abort fails the `upload_id` is put back. A complete that gets `NoSuchUpload` checks the object: present (an earlier complete whose response was lost) → it continues; absent (expired/aborted) → `failed`, `409`.
- Queue: BullMQ `video-processing`, job `process-video`, id `process-video-{videoId}` (`processVideoJobId`), 3 attempts, exponential backoff. An `UnrecoverableError` (e.g. a stalled job) is final even with attempts left. The payload is `{ videoId }` only (older jobs' extra fields are ignored): the worker reads key, channel and MIME from the row, skips a video that is no longer `processing`, and writes `ready`/`failed` only from `processing`, so a re-delivered job never overwrites a final state. A database error in the `failed` listener is logged instead of crashing the worker; the sweep fails the video later.
- Worker: ffprobe/ffmpeg read the original through a presigned GET; the demuxer is forced from the stored MIME (`mov` for mp4/quicktime, `matroska` for webm/mkv) with a protocol whitelist, so images and disguised playlists are rejected and no URL inside the file is fetched. Both tools use the first video track that is not cover art (`V:0`), so an audio file with a cover is rejected and the thumbnail comes from the track the metadata describes. Tool errors are stored as `"<tool> failed: <stderr>"` with every URL redacted.
- Maintenance sweep (BullMQ scheduler `video-maintenance-sweep`, every 15 min, keeps the last 100 completed/failed sweep jobs; at-least-once, every write conditional): aborts and deletes drafts older than `VIDEO_DRAFT_TTL_HOURS` (24) and fails `processing` videos idle for `VIDEO_PROCESSING_STUCK_MINUTES` (30) that have no live job.

### Storage and limits

- Bucket `streamtube-media` (private): `videos/{channelId}/{videoId}/original.{ext}`, `thumbnails/{channelId}/{videoId}/thumb.jpg`. Keys are built only from UUIDs and the MIME allowlist.
- MIME allowlist: `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`. Max 10 GiB (`VIDEO_MAX_SIZE_BYTES`), part size 10 MiB (`VIDEO_UPLOAD_PART_SIZE_BYTES`, ≥ 5 MiB), up to 10 000 parts (JSON body limit 1 MB in `main.ts`), presigned URLs valid `VIDEO_PRESIGNED_URL_EXPIRES_IN` (900 s).
- `S3_PUBLIC_ENDPOINT`: host used in presigned part URLs. Leave empty for the test suites; set `http://localhost:9000` only to upload from the host. The presign client signs no checksum (`requestChecksumCalculation: WHEN_REQUIRED`), which real S3 needs.
- Other env: `S3_*` (endpoint, region, bucket, credentials, path style), `REDIS_*`, `QUEUE_PREFIX` (default `bull`). See `.env.example`.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings; in test files `jest/unbound-method` (eslint-plugin-jest) replaces `@typescript-eslint/unbound-method`, so `expect(mock.method)` is allowed

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
