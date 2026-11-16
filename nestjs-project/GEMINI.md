# GEMINI.md (`nestjs-project`)

> Portado de [nestjs-project/CLAUDE.md](./CLAUDE.md) para a convenção do **Antigravity**. Mantido sincronizado com `nestjs-project/CLAUDE.md`.

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, storage, queue, etc.) — **never** start the NestJS application server unless the user explicitly asks to run/serve the project.

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
docker compose up -d
docker compose exec nestjs-api npm install
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `mailpit` — Mailpit SMTP `1025`, UI `8025`

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev
npm run build
npm run start:prod
npm test
npm run test:watch
npm run test:cov
npm run test:e2e
npx tsc --noEmit
npm run lint
npm run format
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e
```

## Rules in `.agents/rules/`

Antes de editar arquivos em `nestjs-project/`, respeite as regras portadas em `../.agents/rules/`:
- `nestjs-common-conventions.md`, `nestjs-controllers.md`, `nestjs-dtos.md`, `nestjs-entities.md`, `nestjs-layer-separation.md`, `nestjs-modules.md`, `nestjs-services.md`, `nestjs-testing.md`
- `typeorm-migrations.md`, `typeorm-queries.md`, `typescript-strict.md`, `auth-jwt.md`

## Test Type Selection

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

## Build Assets

Any non-TypeScript runtime asset (`.hbs`, JSON fixtures, etc.) must be declared in `nest-cli.json` under `compilerOptions.assets`.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings
- **REST Conventions:** standard HTTP methods, proper status codes, plural resource nouns, OpenAPI decorators (`@ApiTags`, `@ApiOperation`, `@ApiResponse`, `@ApiBearerAuth`, `ApiErrorEnvelope`).
