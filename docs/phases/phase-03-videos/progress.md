# phase-03-videos — Progress

**Status:** completed
**SIs:** 11/11 completed

### SI-03.1 — Dependencies, Config Namespaces, Env Validation, and Docker Compose
- **Status:** completed
- **Tests:** `src/config/env.validation.integration-spec.ts` passed (included in full `npm test -- --runInBand`: 37/37 suites, 198/198 tests)
- **Observations:** Selected `@nestjs/bullmq@^11.0.5` + `bullmq@^6.7.6` + `ioredis@^5.11.1` + `@aws-sdk/client-s3@^3.1169.0` + `@aws-sdk/s3-request-presigner@^3.1169.0` for Jest CJS compatibility; used `pgsty/silo:latest` in `compose.yaml` as drop-in S3-compatible MinIO fork because `minio/minio` on Docker Hub returned `pull access denied`.

### SI-03.2 — Video Entity, Channel Lookup Helper, and Migration
- **Status:** completed
- **Tests:** `src/database/migrations.integration-spec.ts`, `src/videos/entities/video.entity.integration-spec.ts`, and `src/channels/channels.service.integration-spec.ts` passed (included in full suite)
- **Observations:** Generated `1794877024750-CreateVideos.ts` via TypeORM and formatted cleanly to pass ESLint/Prettier.

### SI-03.3 — Phase 03 Domain Exceptions & S3 Storage Service (`StorageModule`)
- **Status:** completed
- **Tests:** `src/storage/storage.module.spec.ts` and `src/storage/s3-storage.service.integration-spec.ts` passed against live `pgsty/silo` (`minio` service)
- **Observations:** `S3_FORCE_PATH_STYLE=true` configured for path-style local S3 bucket access.

### SI-03.4 — BullMQ Queue Constants & Producer Service
- **Status:** completed
- **Tests:** `src/videos/videos-queue.service.spec.ts` and `src/videos/videos-queue.service.integration-spec.ts` passed against live `redis:7-alpine`
- **Observations:** none

### SI-03.5 — Short Code Utility & Multipart Upload Initiation (`POST /videos/uploads/initiate`)
- **Status:** completed
- **Tests:** `src/videos/short-code.util.spec.ts`, `src/videos/videos-upload.service.spec.ts`, and `src/videos/videos-upload.service.integration-spec.ts` passed
- **Observations:** Uses 11-character `base64url` short code (`crypto.randomBytes(8)`) with PostgreSQL unique constraint collision retry loop.

### SI-03.6 — Part URL Signing, Upload Completion & Abort
- **Status:** completed
- **Tests:** Covered by `src/videos/videos-upload.service.spec.ts` and `src/videos/videos-upload.service.integration-spec.ts`
- **Observations:** none

### SI-03.7 — FFmpeg Media Processor & Dedicated Video Worker (`video-worker`)
- **Status:** completed
- **Tests:** `src/videos/media-processor.service.integration-spec.ts`, `src/videos/video-processing.processor.spec.ts`, and `src/videos/video-processing.processor.integration-spec.ts` passed; `video-worker` container logs verified `Video worker started and listening for BullMQ jobs`
- **Observations:** Compiled both `dist/main.js` and `dist/worker.main.js` via `npm run build`.

### SI-03.8 — Video Query, Byte-Range Streaming (`206`), Download & Thumbnail Service
- **Status:** completed
- **Tests:** `src/videos/videos.service.spec.ts` and `src/videos/videos.service.integration-spec.ts` passed
- **Observations:** Enforces RFC 9110 `206 Partial Content` / `Content-Range` / `Accept-Ranges: bytes` and `416 Range Not Satisfiable`.

### SI-03.9 — Videos REST Controller, Module Wiring & OpenAPI Export
- **Status:** completed
- **Tests:** `src/videos/videos.module.spec.ts` and `src/openapi-export.integration-spec.ts` passed
- **Observations:** Applied `@SkipThrottle()` to `VideosController` (matching `AppController`) so multipart part signing, byte-range streaming, and status polling are not blocked by the global `ThrottlerGuard`. Regenerated `openapi.json` via `npm run openapi:export`.

### SI-03.10 — End-to-End Video Upload, Processing, Streaming & Download Tests
- **Status:** completed
- **Tests:** `test/videos.e2e-spec.ts` passed; full `npm run test:e2e` passed (4/4 suites, 56/56 tests)
- **Observations:** none

### SI-03.11 — Documentation, Diagram, Progress & Definition of Done
- **Status:** completed
- **Tests:** Full DoD checks executed after final edits: `npm test -- --runInBand` (37/37 suites, 198/198 tests), `npm run test:e2e` (4/4 suites, 56/56 tests), `npm run build` (`dist/main.js` and `dist/worker.main.js`), `npx tsc --noEmit`, `npm run openapi:export`, and `npx eslint` on all Phase 03 & modified files (0 errors, 0 warnings). At that point `npm run lint` still failed with 147 errors / 40 warnings inherited from the starter (Phase 01/02 test files); fixed in the post-review revisions below.
- **Observations:** Updated `docs/diagrams/software-arch.mermaid`, `CLAUDE.md`, `GEMINI.md`, `nestjs-project/CLAUDE.md`, `nestjs-project/GEMINI.md`, and `README.md` (including Phase 03 docs and Antigravity + Gemini 4 Hydrogen justification).

## Post-review revisions (2026-11-17)

Peer review (auditor: Claude; builder: Antigravity) rejected the delivery with two blocking findings; the fixes were made on `bugfix/phase-03-review-fixes` (from `dev`).

- **Lint (`npm run lint`).** 147 errors in inherited test files made the Definition of Done fail. Typed the `any` casts with the real entities, typed `src/test/mailpit.ts`, and swapped `@typescript-eslint/unbound-method` for `jest/unbound-method` (`eslint-plugin-jest@^29.17.1`) in test files, as typescript-eslint recommends. Lint now reports 0 errors and 0 warnings. The `revoked_at: null` filter in `auth.service.integration-spec.ts` was silently dropped by TypeORM (see `typeorm-queries` rule) and now uses `IsNull()`.
- **`completeUpload` ordering (SI-03.6).** The `draft → processing` claim now runs before the S3 completion and is the lock against concurrent completes (loser gets `409` without touching S3). A rejected part list reverts to `draft`; a failed enqueue marks the video `failed` with `processing_error` instead of leaving it in `processing` with no job. Tests: 3 new unit cases in `videos-upload.service.spec.ts`, 2 new integration cases in `videos-upload.service.integration-spec.ts` (enqueue failure persisted in Postgres; two concurrent completes against real MinIO).
- **`completeUpload` after the S3 completion (round 2 follow-up).** The round 2 auditor (Antigravity) noted that a `HeadObject` failure after `CompleteMultipartUpload` still left the row in `processing` with no job. It now marks `failed` with `processing_error` (`upload_id` cleared). The oversized-object branch records `failed` before deleting the object, so a failed delete only orphans the object. Tests: 2 new unit cases, 1 new integration case (`HeadObject` failure persisted in Postgres).
- **Infra.** `pgsty/silo` pinned to `RELEASE.2026-11-12T00-00-00Z` (was `latest`); `video-worker` gets `restart: unless-stopped` so it recovers after `npm install` on a fresh clone; `.env.example` documents when `S3_PUBLIC_ENDPOINT` must stay empty.
- **AI foundation (MCP).** context7 and Postgres added to the Antigravity MCP config (user-level `mcp_config.json`, outside the repo); the versioned equivalent is `.agents/mcp_config.example.json`. `library-refs.md` re-verified through context7 (version gaps flagged there).
- **Docs aligned with code.** TD-01, `context.md` and SI-03.1 named `@nestjs/bullmq@^12.0.2` / `ioredis@^6.0.0`; the code pins `^11.0.5` / `^5.11.1`. TD-02 now documents the presigned-URL host; TD-04, SI-03.6 and Events/Messages describe the new `completeUpload` order. These are dated revisions; `plan-context` / `plan-validate` were not re-run, since the decisions themselves did not change.
