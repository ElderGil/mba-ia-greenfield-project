# GEMINI.md

> Portado de [CLAUDE.md](./CLAUDE.md) para a convenção do **Antigravity** (usando o modelo **Gemini 4 Hydrogen**). Mantido sincronizado com `CLAUDE.md`.

## Project Overview

StreamTube — a video sharing platform (YouTube-like). Users can upload, manage, and publish videos. Anonymous users can watch freely; social features (comments, subscriptions, likes) require authentication.

More info in the project overview: [docs/project-plan.md](docs/project-plan.md)

## Repository Structure

This is a monorepo with three main areas:

- `nestjs-project/` — Backend API & Video Worker (NestJS 11, TypeScript, Express, TypeORM, BullMQ, AWS SDK v3, FFmpeg). Contains modules `auth/`, `users/`, `channels/`, `mail/`, `storage/`, `videos/`, `common/`, `config/`, `database/`, `swagger/`, plus `worker.main.ts` / `worker.module.ts`.
- `docs/` — Project documentation, architecture diagrams, technical decisions, and planning (`docs/phases/phase-03-videos/`).
- `next-frontend/` (Next.js 16) — Fases 01–02 (fora do escopo da Fase 03).

## Architecture (C4 Container Diagram)

See `docs/diagrams/software-arch.mermaid` for the full diagram. Key containers:

- **Frontend** (Next.js) → calls API via REST (today: the auth screens of Phases 01–02; it has no video screen yet). Target architecture for video: it streams from the API (`/videos/:shortCode/stream`, player in Phase 05) and, the bucket being private, talks to storage only to `PUT` upload parts through presigned URLs
- **API** (Nest.js `nestjs-api`) → business rules, auth, reads/writes DB, issues S3 presigned multipart URLs, streams byte-range playback (`206`) & downloads, publishes jobs to queue, sends emails
- **Video Worker** (Nest.js `video-worker` + FFmpeg/ffprobe) → consumes `video-processing` jobs from BullMQ/Redis, extracts duration/metadata and JPEG thumbnail, updates DB and storage; runs the 15-min maintenance sweep (stale drafts, orphaned `processing` videos)
- **Database** (PostgreSQL 17) → `users`, `channels`, `refresh_tokens`, `verification_tokens`, `videos`
- **Object Storage** (S3-compatible / MinIO via `pgsty/silo`) → private bucket `streamtube-media` (`videos/{channelId}/{videoId}/...`, `thumbnails/{channelId}/{videoId}/thumb.jpg`)
- **Message Queue** (BullMQ + Redis 7) → `video-processing` job queue (`process-video`)
- **Email Service** (SMTP / Mailpit) → account confirmation and password recovery

## Videos (Phase 03)

Upload (S3 multipart with presigned part URLs, resumable via `GET /videos/:id/uploads/parts`), background processing (BullMQ `video-processing` + `video-worker` with ffprobe/ffmpeg), public playback (Range `206`, download, thumbnail) and the `draft → processing → ready | failed` lifecycle. Endpoints, limits, env vars, storage keys and conventions: [nestjs-project/GEMINI.md](nestjs-project/GEMINI.md) → "Videos (Phase 03)".

## Docker Networking

This project runs entirely in Docker containers. When configuring connections between services (database, cache, queue, etc.), **always use the Docker Compose service name** as the host — never `localhost` or `127.0.0.1`.

Inside a container, `localhost` refers to the container itself, not the host machine or other containers. Services communicate through the Docker Compose network using their service names (e.g., `db`, `nestjs-api`).

- **Correct:** `DB_HOST=db` (the Compose service name)
- **Wrong:** `DB_HOST=localhost`

This applies to all environment variables, configuration files, and code that references service hosts.

## Working Principles

- **Single Responsibility:** each module, service, and function should have a clear, focused responsibility. Re-evaluate adherence at every step — when a module starts owning logic or entities that are not its own (e.g., a service creating an entity from another domain), extract it immediately into the proper module instead of deferring to a later corrective task.
- **Type Safety:** Strict TypeScript usage across all layers.
- **Testing:** Strong emphasis on pyramid testing at all levels to ensure reliability and maintainability.
- **Code Quality:** Use ESLint and Prettier for consistent code style. Code reviews should focus on readability, maintainability, and adherence to best practices.
- **Documentation:** Comprehensive docs for architecture, setup, and troubleshooting in `docs/`.

## Definition of Done (Technical)

A change is only considered complete when **all** of the following pass:

1. The relevant test suite passes (unit + integration + e2e affected by the change).
2. The full test suite passes before finishing the task.
3. TypeScript compiles cleanly: `npx tsc --noEmit` exits with code 0. Compilation errors must never be left as debt for future tasks.
4. Lint passes: `npm run lint`.

If any of these fails, the task is not done — fix the underlying issue before declaring completion.

## Git Conventions

- **Main branch:** `main` — never commit directly to it
- Branches: `feature/*`, `bugfix/*`, `hotfix/*`, `docs/*`
- **Commits:** short, descriptive messages focused on the "why" of the change
- **Workflow:** Git Flow conventions. Two long-lived branches:
  - `main` — stable, production-ready code
  - `dev` — integration branch; all feature/bugfix/hotfix branches start from `dev` and merge back into `dev`
  - When `dev` is stable, it is merged into `main`

## Testing Policy

Every change must be tested. During development, run only the tests related to the modified code. Before finishing, always run the full test suite to ensure nothing is broken.

## Scope Limits

- Work on **one feature, fix, or refactoring at a time** — do not mix scopes
- Do not include cosmetic changes (formatting, renaming) alongside functional changes
- If something out of scope comes up during work, note it as a separate task instead of acting on it
- Focus on the defined scope for each task to ensure clarity and maintainability of the codebase.
- If you identify a necessary change that is out of scope, create a new issue or task for it instead of including it in the current work.

## Agent Skill Usage

When working on any task (planning, implementing, debugging, refactoring,
reviewing, etc.), decompose the request into its underlying subtasks and
concerns, then identify which available skills match any of them and activate
those skills. (In Claude Code a `UserPromptSubmit` hook repeats this on every
prompt; this file is always on in Antigravity, so the instruction lives here.)

## Antigravity Ported Foundation (`.agents/`)

A fundação de `.claude/` foi portada para a convenção do Antigravity (docs oficiais: `antigravity.google/docs/rules`, `/skills`, `/subagents`):

- **Rules:** `.agents/rules/*.md`, com frontmatter `trigger: glob` + `globs:` (convertido do `paths:` do Claude Code). Uma rule sem `trigger` válido é descartada em silêncio pelo Antigravity; mantenha esse formato ao criar ou editar rules. Elas ativam sozinhas quando o agente mexe em arquivos que casam com os globs.
- **Skills:** `.agents/skills/<nome>/SKILL.md` (mesmo formato, `description` no frontmatter): `research`, `plan-context`, `plan-validate`, `plan-resolve`, `plan-build`, `plan-test-specs`, `plan-pipeline`, `implement`, `implement-phase`, `decide`, `nestjs-best-practices`, `typeorm`, `testing-guide-nestjs-project`, entre outras.
- **Sub-agents de leitura:** `.agents/agents/` (`plan-reader`, `phases-reader`, `decisions-reader`, `decisions-detail-reader`, `decisions-correlator`, `inventory-digest-reader`), com `subagent: true`, ferramentas só de leitura e execução de comandos desligada. Os contratos de entrada e saída são os mesmos de `.claude/agents/`.
- **Servidores MCP:** o `.mcp.json` (Postgres) e o context7 vão num `mcp_config.json` do Antigravity. O caminho mudou entre versões; ache o arquivo pela interface (painel do agente → **…** → **MCP Servers** → **Manage MCP Servers** → **View raw config**, ou no app: **Customizations** → **MCP Servers** → **Copy Config File Path**). A documentação atual (antigravity.google/docs/mcp, consultada em 2026-11-20) usa `~/.gemini/config/mcp_config.json` para todos os projetos ou `.agents/mcp_config.json` só para este workspace; versões anteriores usavam `~/.gemini/antigravity/mcp_config.json`. O equivalente versionado, sem segredos, é `.agents/mcp_config.example.json`: copie as entradas `context7` e `postgres` para o arquivo que a interface indicar e recarregue os MCPs. O MCP do Postgres usa `localhost:5432`: um PostgreSQL nativo escutando nessa porta no host responde no lugar do container `db`.

As skills foram escritas para o Claude Code e citam as ferramentas dele. No Antigravity, leia assim:

| Nas skills (Claude Code) | No Antigravity |
|---|---|
| `Agent` tool com `subagent_type: <nome>` | `invoke_subagent` com o agente `<nome>` de `.agents/agents/` |
| `Read` / `Grep` / `Glob` | `view_file` / `grep_search` / `find_by_name` |
| `Bash` | `run_command` |
| `CLAUDE.md` | este `GEMINI.md` (atualize os dois juntos: o repositório também é usado com o Claude Code) |

## Library Documentation Lookup

Before implementing any feature, you MUST use the **context7** MCP tool (configured as described in "Antigravity Ported Foundation") to look up the relevant library APIs for the exact installed version. If context7 is not available in the session, stop and configure it instead of falling back silently; record the source you used in `library-refs.md`.

Always:
- Check the installed library version in the project manifest (`package.json` / `package-lock.json`)
- Retrieve the corresponding official documentation
- Cross-reference APIs to avoid deprecated or incompatible patterns
- Follow the official documentation over training data

Skip documentation lookup only for trivial operations such as:

- Variable declarations
- Basic control flow
- Simple CRUD using established project patterns

If a library is involved and there is uncertainty, documentation lookup is mandatory.
If the documentation returned does not match the installed version, flag the discrepancy before proceeding.
