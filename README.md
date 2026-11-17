# StreamTube — Plataforma de Compartilhamento de Vídeos

Projeto da disciplina **Desenvolvimento de Aplicações de IA** do MBA de Engenharia de Software com IA da [Full Cycle](https://fullcycle.com.br).

Este é um projeto greenfield desenvolvido para demonstrar como construir uma aplicação do zero utilizando IA de forma adequada no processo de desenvolvimento.

## Professor

<a href="https://github.com/argentinaluiz">
    <img src="https://avatars.githubusercontent.com/u/4926329?v=4?s=100" width="100px;" alt=""/>
    <br />
    <sub>
        <b>Luiz Carlos</b>
    </sub>
</a>

---

## Quadro Branco

- [Quadro Branco](./whiteboard.png)

---

## 🎨 Design System (Figma)

- [FC Tube.fig](./FC%20Tube.fig) — arquivo-fonte do **design system** do projeto no Figma.
- [FC Tube sem padrão.fig](./FC%20Tube%20sem%20padrao.fig) — arquivo-fonte puro, sem tokens, cores, tipografia e espaçamento.

Contém os fundamentos visuais do StreamTube — tokens (cores, tipografia, espaçamento, raios), componentes e as telas da plataforma. É a referência de design para a implementação do frontend: os componentes em `next-frontend/components/ui` (shadcn) e os tokens em `next-frontend/app/globals.css` derivam deste arquivo. Abra-o no Figma (`Arquivo → Importar`) para consultar especificações e estados visuais.

---

## 📋 Pré-requisitos

- Docker e Docker Compose
- Node.js v25+ (para rodar os testes E2E do Playwright no host)
- npm

## 🏗️ Arquitetura

O projeto é um monorepo baseado em containers Docker. Cada subprojeto sobe sua própria stack via `docker compose`.

- **Frontend** (Next.js 16, App Router + React Server Components) — interface da plataforma. Segue o **modelo BFF**: o navegador nunca chama a API NestJS diretamente; todo tráfego passa por Route Handlers same-origin em `app/api/**`, que fazem proxy server-side para a API.
- **API** (NestJS 11) — regras de negócio, autenticação (JWT + refresh token rotation), envio de e-mails, upload multipart pré-assinado, streaming HTTP `206 Partial Content`, download e acesso ao banco.
- **Database** (PostgreSQL 17) — usuários, canais, tokens de autenticação e vídeos.
- **Email Service** (Mailpit) — captura os e-mails transacionais (confirmação de conta e recuperação de senha) em uma UI local.
- **Video Worker** (NestJS standalone + FFmpeg/ffprobe) — consome a fila `video-processing`, extrai duração e metadados e gera thumbnails JPEG automaticamente.
- **Object Storage** (S3-compatível via `pgsty/silo` / MinIO) — bucket privado `streamtube-media` para arquivos de vídeo e thumbnails.
- **Message Queue** (BullMQ + Redis 7) — fila de processamento assíncrono de vídeos (`process-video`, retries com backoff exponencial).

O diagrama de arquitetura completo (C4) está em `docs/diagrams/software-arch.mermaid`.

## 🚀 Como rodar

Os dois subprojetos têm stacks Docker **separadas**. Suba primeiro o backend, rode as migrations e depois o frontend.

### 1. Backend (NestJS + PostgreSQL + Mailpit + MinIO/S3 + Redis + Video Worker)

```bash
cd nestjs-project

# Copie o .env (caso ainda não exista)
cp .env.example .env

# Sobe API, worker de vídeo, Postgres, Mailpit, MinIO (pgsty/silo) e Redis
docker compose up -d

# Instala dependências (apenas na primeira vez)
docker compose exec nestjs-api npm install

# Cria o schema do banco (obrigatório — synchronize está desabilitado)
docker compose exec nestjs-api npm run migration:run

# Sobe o servidor de desenvolvimento em watch mode
docker compose exec -d nestjs-api npm run start:dev
```

Serviços disponíveis:

| Serviço | URL / Porta |
|---------|-------------|
| API NestJS | http://localhost:3000 |
| PostgreSQL | `localhost:5432` (db/user/senha: `streamtube`) |
| Mailpit (UI de e-mails) | http://localhost:8025 |
| Object Storage (S3 API / Console) | http://localhost:9000 / http://localhost:9001 (`minioadmin` / `minioadmin`) |
| Redis (BullMQ) | `localhost:6379` |
| Swagger (opcional) | http://localhost:3000/api/docs — habilite com `SWAGGER_ENABLED=true` |

### 2. Frontend (Next.js)

```bash
cd next-frontend

# Garanta que o .env.local existe (veja .env.example)
# API_URL aponta para o backend; SESSION_PASSWORD protege a sessão (iron-session)

docker compose up -d
docker compose exec next-frontend npm install        # apenas na primeira vez
docker compose exec -d next-frontend npm run dev
```

A aplicação ficará disponível em **http://localhost:3001**.

> As stacks são separadas, então o frontend acessa o backend via `host.docker.internal:3000` (configurado em `next-frontend/.env.local` e no `extra_hosts` do compose).

## 🧪 Testes

### Backend (Jest)

```bash
cd nestjs-project
docker compose exec nestjs-api npm test               # unitários + integração
docker compose exec nestjs-api npm run test:e2e       # end-to-end (HTTP via supertest)
docker compose exec nestjs-api npm run test:cov       # cobertura
```

Sufixos: `*.spec.ts` (unitário), `*.integration-spec.ts` (integração com banco real), `*.e2e-spec.ts` (end-to-end). Testes de integração/e2e rodam com `--runInBand`.

### Frontend (Vitest + Playwright)

```bash
cd next-frontend
docker compose exec next-frontend npm test            # unitários + integração (Vitest + MSW)
npx playwright test                                   # end-to-end (no host, com dev server em MSW_ENABLED=true)
```

Sufixos: `*.test.ts(x)` (unitário), `*.integration.test.ts(x)` (Route Handlers com MSW), `*.e2e-spec.ts` (Playwright). MSW intercepta as chamadas à API NestJS — os testes nunca batem no backend real.

## ✅ Funcionalidades implementadas

**Fase 01 — Configuração base**, **Fase 02 — Autenticação** (backend + frontend) e **Fase 03 — Upload e Processamento de Vídeos** (backend) estão concluídas.

### Vídeos — Upload, Processamento, Streaming e Download (Fase 03)

Fluxo completo para vídeos de até **10 GiB** sem bloquear a API:
1. `POST /videos/uploads/initiate` cria o vídeo pré-cadastrado como `draft`, gera um `shortCode` único de 11 caracteres (`crypto.randomBytes(8).toString('base64url')` com constraint `UNIQUE` e retry) e abre um upload multipart no S3/MinIO (`videos/{channelId}/{videoId}/original.{ext}`).
2. `POST /videos/:id/uploads/parts` gera URLs pré-assinadas por parte para envio direto do cliente ao object storage.
3. `POST /videos/:id/uploads/complete` conclui o multipart, valida `HeadObject`, transiciona atomicamente `draft` → `processing` e publica o job `process-video` no BullMQ/Redis (`POST /videos/:id/uploads/abort` cancela e remove rascunhos abortados).
4. O container `video-worker` (`WorkerModule` + `ffmpeg`/`ffprobe`) extrai `durationSeconds`, `width`, `height`, `codec`, gera o thumbnail JPEG (`thumbnails/{channelId}/{videoId}/thumb.jpg`) e atualiza para `ready` (ou `failed` com `processingError` após esgotar as tentativas).
5. Endpoints `@Public()` entregam metadados, thumbnail JPEG, streaming com `Range` / `206 Partial Content` (`Accept-Ranges: bytes`) e download (`Content-Disposition: attachment`) para vídeos `ready`.

Endpoints da Fase 03 (`nestjs-project`):

| Método & Rota | Auth | Descrição |
|---------------|------|-----------|
| `POST /videos/uploads/initiate` | JWT | Pré-cadastra vídeo como `draft`, gera `shortCode` único e inicia multipart no S3 |
| `POST /videos/:id/uploads/parts` | JWT (dono) | Gera URL pré-assinada `PUT` para uma parte do upload |
| `POST /videos/:id/uploads/complete` | JWT (dono) | Conclui multipart, valida objeto, muda para `processing` e enfileira job BullMQ |
| `POST /videos/:id/uploads/abort` | JWT (dono) | Aborta upload multipart e remove o rascunho |
| `GET /videos/me` | JWT | Lista vídeos do canal autenticado |
| `GET /videos/:id/status` | JWT (dono) | Consulta status, metadados extraídos e eventual erro de processamento |
| `GET /videos/:shortCode` | Pública | Metadados públicos e URLs de stream/download/thumbnail (vídeo `ready`) |
| `GET /videos/:shortCode/stream` | Pública | Streaming via `Range` (`206 Partial Content`) ou `200 OK` |
| `GET /videos/:shortCode/download` | Pública | Download do arquivo completo (`Content-Disposition: attachment`) |
| `GET /videos/:shortCode/thumbnail` | Pública | Thumbnail JPEG gerada pelo worker |

### Autenticação (Fase 02)

Fluxo completo de **cadastro → confirmação por e-mail → login → recuperação de senha**, com canal criado automaticamente para cada usuário (a partir do prefixo do e-mail).

Endpoints da API (`nestjs-project`):

| Método & Rota | Descrição |
|---------------|-----------|
| `POST /auth/register` | Cadastro de usuário (cria usuário + canal) |
| `GET /auth/confirm-email?token=` | Confirmação de conta via link do e-mail |
| `POST /auth/resend-confirmation` | Reenvio do e-mail de confirmação |
| `POST /auth/login` | Login (retorna access + refresh token) |
| `POST /auth/refresh` | Rotação de refresh token (com family + grace period) |
| `POST /auth/logout` | Revoga os refresh tokens da sessão |
| `POST /auth/forgot-password` | Solicita e-mail de recuperação de senha |
| `POST /auth/reset-password` | Redefine a senha via token |
| `GET /auth/me` | Dados do usuário autenticado (protegido por JWT) |

Telas e Route Handlers BFF (`next-frontend`):

- `/(auth)/signup`, `/(auth)/login`, `/(auth)/forgot-password` — formulários com React Hook Form + Zod e validação inline.
- `app/api/auth/{signup,login,logout,forgot-password}` — proxy same-origin para a API.

Segurança: senhas com **Argon2**, **JWT** com `JwtAuthGuard` global (opt-out via `@Public()`), **rotação de refresh token** com detecção de reuso, **rate limiting** (`ThrottlerGuard`) nos endpoints de auth, e sessão no navegador via **iron-session** (cookies HTTP-only).

## 🛠️ Estrutura do Projeto

```
green-field-ia-project/
├── docs/
│   ├── project-plan.md                  # Planejamento geral do projeto
│   ├── decisions/                       # Decisões técnicas (ADRs/TDs por fase)
│   │   └── technical-decisions-phase-03-videos.md
│   ├── phases/                          # Planos e implementação por fase
│   │   ├── phase-01-configuracao-base/
│   │   ├── phase-02-auth/               # Auth (backend)
│   │   ├── phase-02-auth-frontend/      # Auth (frontend)
│   │   └── phase-03-videos/             # Vídeos (backend)
│   └── diagrams/
│       └── software-arch.mermaid        # Diagrama de arquitetura (C4)
├── nestjs-project/                      # Backend API & Worker (NestJS 11)
│   ├── src/
│   │   ├── auth/                        # Cadastro, login, JWT, refresh, reset de senha
│   │   ├── users/                       # Entidade e serviço de usuários
│   │   ├── channels/                    # Canal 1:1 por usuário (nickname do e-mail)
│   │   ├── mail/                        # Envio de e-mails (templates Handlebars)
│   │   ├── storage/                     # S3/MinIO client, multipart e streaming
│   │   ├── videos/                      # Upload, fila BullMQ, FFmpeg processor, streaming
│   │   ├── common/                      # Filtros, pipes e exceptions de domínio
│   │   ├── config/                      # Configs namespaced (Joi)
│   │   ├── database/                    # data-source, migrations e seeds
│   │   ├── worker.main.ts               # Entrypoint do container video-worker
│   │   └── worker.module.ts             # Módulo NestJS standalone do worker
│   ├── test/                            # Testes e2e
│   ├── compose.yaml                     # Docker Compose (API, worker, Postgres, Mailpit, MinIO, Redis)
│   └── Dockerfile.dev                   # Node 25 + FFmpeg/ffprobe
├── next-frontend/                       # Frontend (Next.js 16, App Router)
│   ├── app/                             # Rotas, layouts, páginas e Route Handlers BFF
│   ├── components/                      # Componentes de auth, UI (shadcn) e ícones
│   ├── lib/                             # env, api (openapi-fetch), auth/session
│   ├── mocks/                           # MSW (handlers + server)
│   ├── tests/                           # E2E (Playwright)
│   ├── compose.yaml                     # Docker Compose (dev server)
│   └── Dockerfile.dev
├── CLAUDE.md                            # Instruções para IA
├── FC Tube.fig                          # Design system do projeto (Figma)
├── whiteboard.png                       # Quadro branco do projeto
└── README.md
```

## 📚 Fases do Projeto

| Fase | Descrição | Status |
|------|-----------|--------|
| **01** | Configuração Base do Projeto | ✅ Concluída |
| **02** | Cadastro, Login e Gerenciamento de Conta | ✅ Concluída |
| **03** | Upload e Processamento de Vídeos | ✅ Concluída (Backend) |
| **04** | Gerenciamento de Vídeos e Canal | ⏳ Planejada |
| **05** | Página de Visualização do Vídeo | ⏳ Planejada |
| **06** | Interações Sociais (Likes, Comentários, Inscrições) | ⏳ Planejada |
| **07** | Página Inicial, Busca e Finalização | ⏳ Planejada |

Detalhes completos em `docs/project-plan.md`.

## 📖 Stack Tecnológica

| Camada | Tecnologia |
|--------|------------|
| Frontend | Next.js 16, React 19, TypeScript, Tailwind CSS 4, shadcn/ui, React Hook Form + Zod, iron-session, openapi-fetch |
| Backend | NestJS 11, TypeScript, TypeORM, JWT, Argon2, Mailer (Handlebars), BullMQ, AWS SDK v3 (`@aws-sdk/client-s3`), FFmpeg/ffprobe |
| Banco de Dados | PostgreSQL 17 |
| Object Storage | S3-compatível (`pgsty/silo` / MinIO em dev) |
| Fila / Broker | Redis 7 + BullMQ |
| E-mail (dev) | Mailpit |
| Containerização | Docker, Docker Compose |
| Testes | Jest, Supertest (backend); Vitest, MSW, Playwright (frontend) |
| Qualidade | ESLint, Prettier |

## 🤖 Ferramenta de Desenvolvimento (Antigravity + Gemini 4 Hydrogen)

Como iniciativa extra na condução da **Fase 03**, optamos por utilizar o **Google Antigravity** com o modelo **Gemini 4 Hydrogen** (recém-lançado para engenharia de software e código), avaliando sua capacidade de conduzir uma entrega greenfield complexa de ponta a ponta.

Para respeitar o workflow do projeto fora do Claude Code:
- Portamos a fundação de IA de `.claude/` (`skills/`, `rules/`) e `CLAUDE.md` para a convenção nativa do Antigravity em `.agents/skills/`, `.agents/rules/`, [GEMINI.md](./GEMINI.md) e [nestjs-project/GEMINI.md](./nestjs-project/GEMINI.md), mantendo os `CLAUDE.md` sincronizados.
- Seguimos rigorosamente todas as etapas da pipeline do projeto antes de codar: **Research** ([technical-decisions-phase-03-videos.md](./docs/decisions/technical-decisions-phase-03-videos.md)) → **Plan Context** ([context.md](./docs/phases/phase-03-videos/context.md)) → **Plan Validate** ([validation.md](./docs/phases/phase-03-videos/validation.md) em status `clean`) → **Plan Resolve** ([library-refs.md](./docs/phases/phase-03-videos/library-refs.md)) → **Plan Build** ([phase-03-videos.md](./docs/phases/phase-03-videos/phase-03-videos.md)) → **Implementação SI a SI** ([progress.md](./docs/phases/phase-03-videos/progress.md)).
</content>
