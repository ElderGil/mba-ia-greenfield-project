---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-16T16:15:32-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-16T21:27:05-0300"
  docs/decisions/technical-decisions-phase-02-auth.md: "2026-11-16T16:15:32-0300"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-11-16T16:15:32-0300"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-16T16:15:32-0300"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-16T16:15:32-0300"
  docs/phases/phase-02-auth/context.md: "2026-11-16T16:15:32-0300"
  .agents/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-16T16:23:12-0300"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de metadados/publicação/visibilidade pública vs unlisted (Fase 04), página/player frontend em `next-frontend/` (fora de escopo desta fase; interface de vídeo pertence às Fases 04–05), interações sociais (Fase 06), busca/home (Fase 07).

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — fora de escopo nesta fase (telas de upload/player ficam para fases futuras).

**Sequencing notes:** Depends on Fase 01 — Configuração Base do Projeto e Fase 02 — Cadastro, Login e Gerenciamento de Conta (autenticação JWT e canal 1:1 por usuário).

**Neighbors (for boundary detection only):** Fase 02 — Cadastro, Login e Gerenciamento de Conta (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Message Queue Technology & NestJS Integration | decided | A (BullMQ + Redis via `@nestjs/bullmq`, `bullmq`, `ioredis`) | @nestjs/bullmq, bullmq, ioredis |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Cross-layer | Large Video Upload Strategy (up to 10GB) | decided | A (S3 Multipart Upload with Presigned Part URLs; max 10 GiB, 10 MiB part size, MP4/WebM/MOV/MKV) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Object Storage Client SDK & Bucket/Key Organization | decided | A (AWS SDK v3 + private bucket `streamtube-media` with structured key prefixes) | @aws-sdk/client-s3, @aws-sdk/s3-request-presigner |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Video Draft Lifecycle, Status Machine & Failure Handling | decided | A (4-state lifecycle: `draft` → `processing` → `ready` \| `failed`) | — |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Video Worker Runtime Topology & FFmpeg Execution Strategy | decided | A (Dedicated `video-worker` container + native `ffmpeg`/`ffprobe` via `child_process`) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Cross-layer | Unique Video URL Identifier Strategy | decided | A (11-char `crypto.randomBytes(8).toString('base64url')` + DB `UNIQUE` index with collision retry) | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Cross-layer | Video Streaming & Download Delivery Strategy | decided | A (API Byte-Range `206` stream proxy + attachment download; `@Public()` playback when `ready`) | @aws-sdk/client-s3 |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-04 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04, phase-03-videos/TD-05 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-07 |
| Download do vídeo pelo usuário | phase-03-videos/TD-07 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis — `@nestjs/bullmq` (pinned `^11.0.5`; `12.x` is ESM-only and breaks Jest, see TD-01 revision) officially supports NestJS 11, provides declarative retries/backoff and stalled-job handling, and keeps background job polling off PostgreSQL with a lightweight `redis:7-alpine` container.

**Libraries:** `@nestjs/bullmq`, `bullmq`, `ioredis`

### phase-03-videos/TD-02

**Recommendation:** S3 Multipart Upload with Presigned Part URLs — Single `PUT` caps at 5GB and cannot meet the 10GB requirement; S3 multipart keeps 100% of binary upload traffic off the NestJS API and supports per-part resume without extra server containers. Resolved constraints (AMB-1): max size `10737418240` bytes (10 GiB), default part size `10485760` bytes (10 MiB, configurable 5 MiB–100 MiB), allowed MIME types `video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### phase-03-videos/TD-03

**Recommendation:** AWS SDK v3 + Private Bucket with Prefix Isolation — Vendor-neutral S3 compatibility between local MinIO and production S3, first-class support for `CreateMultipartUpload`/`UploadPart`/`CompleteMultipartUpload`/`GetObject` (`Range`), and private storage enforced by the API. Bucket `streamtube-media`, keys `videos/{channelId}/{videoId}/original.{ext}` and `thumbnails/{channelId}/{videoId}/thumb.jpg`.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### phase-03-videos/TD-04

**Recommendation:** 4-State Lifecycle (`draft` → `processing` → `ready` | `failed`) — Directly matches `project-plan.md`, supports atomic `draft → processing` transition on upload completion, and cleanly represents terminal processing failures.

**Libraries:** —

### phase-03-videos/TD-05

**Recommendation:** Dedicated `video-worker` Container + Native `ffmpeg`/`ffprobe` via `child_process` — Matches the target C4 architecture, avoids deprecated `fluent-ffmpeg`, and keeps API responsiveness isolated from FFmpeg workloads. Resolved extraction contract (AMB-2): persists `durationSeconds` (float/numeric), `width`, `height`, `codec`, `mimeType`, `sizeBytes`, and generates JPEG thumbnail `thumb.jpg` at `1s` with `0s` fallback for clips shorter than 1s.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** 11-char `crypto.randomBytes(8).toString('base64url')` + DB `UNIQUE` constraint — Short, non-enumerable, native to Node 25 with zero ESM/CommonJS friction, and strictly conflict-free via PostgreSQL `UNIQUE` constraint + retry.

**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** API Byte-Range `206 Partial Content` Stream Proxy + `Content-Disposition: attachment` Download — Delivers true seekable streaming without full-file download or memory buffering, avoids MinIO Docker/host SigV4 host-mismatch issues, enforces domain status/access rules in the API, and keeps the route contract clean for Phase 05's video player. Resolved access policy (AMB-3): `GET /videos/:shortCode`, `GET /videos/:shortCode/stream`, `GET /videos/:shortCode/download`, and `GET /videos/:shortCode/thumbnail` are `@Public()` when `status === 'ready'`; upload/abort/status endpoints require JWT (`JwtAuthGuard`) + channel ownership.

**Libraries:** `@aws-sdk/client-s3`

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^18.x` (installed `^18.1.2` in `nestjs-project/package.json`)

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-02

**Recommendation:** Option B (Custom guards with @nestjs/jwt only) — Keeps dependency surface small; global `APP_GUARD` protects all endpoints by default with `@Public()` opt-out.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — Documented NestJS validation approach paired with global `ValidationPipe`.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Standardized `{ statusCode, error, message }` error response shape via `DomainException` subclasses and `DomainExceptionFilter`.

**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger`) — Preserves `class-validator` DTOs with CLI plugin + explicit `@ApiTags`, `@ApiOperation`, `@ApiResponse`, `@ApiBearerAuth`, and `ApiErrorEnvelope` decorators on controllers.

**Libraries:** `@nestjs/swagger@^11.4.2`

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Runtime UI + static `openapi.json` exported via `npm run openapi:export`).

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` uses `autoLoadEntities: true`, `synchronize: false`. Schema changes go exclusively through versioned TypeORM migrations. _(from phase 01)_
- Global `JwtAuthGuard` via `APP_GUARD` protects every HTTP endpoint by default; public endpoints opt out explicitly with `@Public()`. _(from phase 02)_
- Global `ValidationPipe` (`whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`) + `ValidationExceptionFilter` + `DomainExceptionFilter` return `{ statusCode, error, message }`. _(from phase 02)_
- Services throw `DomainException` subclasses (never HTTP exceptions) and never swallow errors; controllers stay thin with no `try/catch` blocks. _(from phase 02)_
- Every user has a 1:1 `Channel` managed by `ChannelsModule` / `ChannelsService`. _(from phase 02)_
- Every controller/DTO uses `@nestjs/swagger` decorators referencing `ApiErrorEnvelope` and exports updated `openapi.json`. _(from openapi-docs-nestjs)_
- Docker Compose networking uses service names (`db`, `mailpit`, `minio`, `redis`), never `localhost`, and all `npm`/`npx`/test commands run inside the container. _(from phase 01 & 02)_

## Inherited Deferred Capabilities

| Capability | Originated in | Status | Rationale |
|---|---|---|---|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | phase-02-auth | completed in `phase-02-auth-frontend` | Auth frontend delivered separately in `next-frontend/` |

## Non-UI / Deferred Capabilities

_None (no UI capabilities in Phase 03 scope; backend-only phase)._

## Testing Requirements

Refer to the `.agents/skills/testing-guide-nestjs-project/SKILL.md` Skill for layer requirements per artifact type in `nestjs-project/`. Phase 03 introduces a new `Video` entity + migration, storage/queue config namespaces, S3/MinIO storage service, BullMQ queue producer and FFmpeg worker processor, video upload/streaming/download services, and REST endpoints (`@Controller('videos')`) — each layer is exercised by unit (`*.spec.ts`), real-infra integration (`*.integration-spec.ts` against PostgreSQL, MinIO, Redis/BullMQ, FFmpeg), and E2E (`*.e2e-spec.ts` via Supertest) tests run with `--runInBand`.
