# StreamTube

Plataforma de compartilhamento e streaming de vídeos com upload direto para object storage S3, processamento assíncrono de mídia em worker dedicado e entrega por HTTP Byte-Range (`206 Partial Content`).

O backend é construído em NestJS 11 com PostgreSQL 17, Redis/BullMQ, storage compatível com S3 (`pgsty/silo` / MinIO em ambiente local) e `ffmpeg`/`ffprobe` para extração de metadados e geração de thumbnail. O frontend utiliza Next.js 16 (App Router) no padrão BFF, mantendo toda comunicação com a API isolada em Route Handlers server-side.

---

## Arquitetura

Diagrama de containers no modelo [C4](https://c4model.com/) (arquivo fonte também em [docs/diagrams/software-arch.mermaid](./docs/diagrams/software-arch.mermaid)).

```mermaid
flowchart TB
    anon["<b>Usuário Anônimo</b><br/>[Pessoa]<br/>Assiste vídeos públicos e consome thumbnails/downloads"]
    auth["<b>Usuário Autenticado</b><br/>[Pessoa]<br/>Publica vídeos, gerencia canal e acompanha processamento"]

    subgraph st ["StreamTube [Sistema]"]
        fe["<b>Frontend</b><br/>[Container: Next.js 16 · App Router BFF]<br/>Interface web e Route Handlers same-origin"]
        api["<b>API</b><br/>[Container: NestJS 11 · REST API]<br/>Auth JWT/Argon2, orquestração de upload S3 e streaming 206"]
        worker["<b>Video Worker</b><br/>[Container: NestJS Standalone · FFmpeg/ffprobe]<br/>Consome fila, extrai metadados e gera thumbnail JPEG"]
        db[("<b>Database</b><br/>[Container: PostgreSQL 17]<br/>users, channels, tokens e videos")]
        s3[("<b>Object Storage</b><br/>[Container: S3 / pgsty-silo]<br/>Bucket privado streamtube-media")]
        queue[["<b>Message Queue</b><br/>[Container: BullMQ / Redis 7]<br/>Fila video-processing"]]
    end

    mail["<b>Email Service</b><br/>[Sistema Externo: SMTP / Mailpit]<br/>Confirmação de cadastro e reset de senha"]

    anon & auth -->|"HTTPS"| fe
    auth -->|"PUT direto por parte pré-assinada<br/>[HTTPS / S3]"| s3
    fe -->|"REST JSON [internal]"| api
    api -->|"Leitura e escrita [TypeORM]"| db
    api -->|"CreateMultipart / Presign / Complete / Stream"| s3
    api -->|"Enfileira process-video"| queue
    api -->|"E-mails transacionais [SMTP]"| mail
    queue -->|"Entrega job [BullMQ]"| worker
    worker -->|"Lê vídeo original / grava thumb.jpg"| s3
    worker -->|"Atualiza metadados e status"| db

    subgraph legenda ["Legenda"]
        direction LR
        l1["Pessoa"]
        l2["Container"]
        l3["Armazenamento / Fila"]
        l4["Sistema Externo"]
        l1 ~~~ l2 ~~~ l3 ~~~ l4
    end

    classDef pessoa fill:#08427B,stroke:#052E56,color:#fff
    classDef container fill:#438DD5,stroke:#2E6295,color:#fff
    classDef store fill:#2E6295,stroke:#1D446B,color:#fff
    classDef externo fill:#6B7280,stroke:#4B5563,color:#fff
    class anon,auth,l1 pessoa
    class fe,api,worker,l2 container
    class db,s3,queue,l3 store
    class mail,l4 externo
```

### Fluxo de ingestão, processamento e entrega de mídia

```mermaid
sequenceDiagram
    participant C as Cliente
    participant API as API (NestJS)
    participant DB as PostgreSQL
    participant S3 as Object Storage (S3)
    participant Q as BullMQ (Redis)
    participant W as Video Worker (FFmpeg)

    C->>API: POST /videos/uploads/initiate
    API->>DB: Cria registro draft + shortCode único (11 chars)
    API->>S3: CreateMultipartUpload
    API-->>C: videoId, shortCode, uploadId

    loop Para cada parte (10 MiB padrão, até 10 GiB total)
        C->>API: POST /videos/:id/uploads/parts
        API-->>C: URL pré-assinada de UploadPart
        C->>S3: PUT parte direto no storage (sem passar pela API)
    end

    opt Cliente perdeu os ETags (reload, queda de conexão)
        C->>API: GET /videos/:id/uploads/parts
        API-->>C: Partes já armazenadas + ETags (retomada)
    end

    C->>API: POST /videos/:id/uploads/complete (ETags)
    API->>DB: Reserva draft -> processing (UPDATE condicional em id + draft + upload_id, perdedor recebe 409)
    API->>S3: ListParts (soma das partes, acima de 10 GiB: 413 e abort, nada é montado)
    API->>S3: CompleteMultipartUpload + HeadObject
    API->>Q: Enfileira process-video só com o videoId (falha -> failed)
    API-->>C: 202 / status processing

    Q->>W: Entrega job process-video
    W->>DB: Lê o vídeo (job de vídeo fora de processing é ignorado)
    W->>S3: ffprobe/ffmpeg leem o original por URL GET pré-assinada (sem baixar o arquivo inteiro)
    W->>W: ffprobe (duração, codec, resolução) + ffmpeg (thumb.jpg), demuxer forçado pelo MIME, trilha V:0
    W->>S3: PutObject thumbnails/{channelId}/{videoId}/thumb.jpg
    W->>DB: processing -> ready (ou failed), só a partir de processing

    C->>API: GET /videos/:shortCode/stream (Range: bytes=...)
    API->>API: Condicionais antes do Range (If-None-Match -> 304, If-Range)
    API->>S3: GetObject com Range
    API-->>C: 206 Partial Content + Content-Range + ETag (404 se não estiver ready)
```

---

## Decisões de engenharia e arquitetura

As decisões da plataforma estão formalizadas em [docs/decisions/technical-decisions-phase-03-videos.md](./docs/decisions/technical-decisions-phase-03-videos.md). Os pontos centrais da arquitetura atual:

1. **Upload multipart direto para S3 (`VideosUploadService`)** — Arquivos de até **10 GiB** (`10737418240` bytes, partes padrão de `10 MiB`) nunca trafegam pelo processo Node.js da API. A API apenas valida permissões/MIME (`video/mp4`, `video/webm`, `video/quicktime`, `video/x-matroska`), cria o vídeo em estado `draft` e assina URLs `PUT` por parte diretamente contra o bucket privado `streamtube-media` (`videos/{channelId}/{videoId}/original.{ext}`). Validado com um upload real de exatamente 10 GiB: 1.024 partes de 10 MiB em 77 s, `ready` 4 s depois do `complete` e `206` corretos depois dos 4 GiB.
2. **Identificador público compacto (`shortCode`)** — Gerado com `crypto.randomBytes(8).toString('base64url')` (11 caracteres URL-safe) em [short-code.util.ts](./nestjs-project/src/videos/short-code.util.ts), respaldado por índice `UNIQUE` em `videos.short_code` e retry em colisão (`23505`) no [VideosUploadService](./nestjs-project/src/videos/videos-upload.service.ts).
3. **Fila BullMQ/Redis com worker isolado (`video-worker`)** — Processamento de vídeo (`ffmpeg`/`ffprobe`) é CPU/I/O-bound e roda em container separado ([worker.main.ts](./nestjs-project/src/worker.main.ts) / [WorkerModule](./nestjs-project/src/worker.module.ts)) consumindo a fila `video-processing` com backoff exponencial. O job carrega só o `videoId`; chave, canal e MIME vêm do banco. A versão `@nestjs/bullmq@^11.0.5` foi fixada intencionalmente no lugar da `12.x` (ESM-only) para preservar compatibilidade CJS na suíte Jest.
4. **Execução nativa de `ffmpeg`/`ffprobe` sem wrappers** — [MediaProcessorService](./nestjs-project/src/videos/media-processor.service.ts) invoca os binários nativos via `child_process.execFile` (sem `fluent-ffmpeg`), extraindo `durationSeconds`, `width`, `height`, `codec` e thumbnail JPEG em `min(1s, duração/2)` (com fallback para o primeiro quadro). O demuxer é forçado a partir do MIME declarado no upload (`mov` para mp4/quicktime, `matroska` para webm/mkv), com whitelist de protocolo: imagem enviada como vídeo é recusada e uma playlist HLS disfarçada de `.mp4` não faz o worker buscar URLs (SSRF). As duas ferramentas usam a primeira trilha de vídeo que não é capa (`V:0`), então um áudio com capa não passa como vídeo. Erros das ferramentas vão para `processingError` sem a URL pré-assinada.
5. **Streaming proxy com suporte a `Range` (`206 Partial Content`)** — [VideosService](./nestjs-project/src/videos/videos.service.ts) mantém o bucket privado e entrega `/videos/:shortCode/stream` pela API, em vez de redirecionar para uma URL pré-assinada: o acesso é checado a cada requisição (vídeo fora de `ready` responde `404`, igual a um shortCode inexistente) e não há URL presa ao hostname interno do Docker (`minio:9000`). A semântica segue a RFC 9110: condicionais antes do `Range` (`If-None-Match` → `304`, `If-Range` com ETag antiga → arquivo inteiro), `HEAD` sem `Range` e sem abrir o storage, `416` com `Content-Range: bytes */tamanho`. As respostas de mídia passam por `sendMedia()` ([videos-http.util.ts](./nestjs-project/src/videos/videos-http.util.ts)): storage aberto só quando necessário e fechado se o cliente sair, `pipeline()` em vez de `pipe()` e `Content-Disposition` RFC 6266 (nome em UTF-8 com fallback ASCII).
6. **Ciclo do upload à prova de concorrência** — Concluir, cancelar e a varredura de manutenção disputam o draft pela mesma condição (`UPDATE` em `id` + `draft` + `upload_id`, [video-upload-session.ts](./nestjs-project/src/videos/video-upload-session.ts)) antes de qualquer chamada destrutiva no S3: só um segue, o outro recebe `409` sem tocar no storage. Antes de montar o objeto, o `complete` soma as partes gravadas e cancela o upload acima do limite (a URL pré-assinada não limita o tamanho de cada `PUT`). Partes rejeitadas pelo S3 devolvem o vídeo para `draft`; um `complete` cuja resposta se perdeu é reconciliado pelo objeto já gravado. Depois que o S3 fecha o multipart, qualquer falha (`HeadObject`, tamanho, enfileiramento) termina em `failed` com o motivo em `processingError`, nunca em `processing` sem job.
7. **Storage local com `pgsty/silo`** — Como a imagem oficial `minio/minio` no Docker Hub passou a retornar `pull access denied`, o [compose.yaml](./nestjs-project/compose.yaml) utiliza `pgsty/silo` (fork comunitário S3-compatível drop-in), fixado na tag `RELEASE.2026-11-12T00-00-00Z`, com `S3_FORCE_PATH_STYLE=true`.
8. **Worker que não deixa vídeo preso e limites de abuso** — O `video-worker` espera o `npm install` num clone novo e então faz `exec node` (sem `npm run` como PID 1), então `docker compose stop` entrega SIGTERM ao Nest e o BullMQ termina o job ativo. Ele só grava `ready`/`failed` a partir de `processing`, assim um job reentregue não sobrescreve um estado final, e job falho por travamento (`UnrecoverableError`) marca `failed` mesmo com tentativas restantes. Uma varredura a cada 15 min ([VideoMaintenanceService](./nestjs-project/src/videos/video-maintenance.service.ts), agendada pelo BullMQ) passa por todos os drafts abandonados há mais de 24 h (cancela o multipart e remove) e marca `failed` os vídeos em `processing` sem job vivo há mais de 30 min. O `initiate` tem throttle (10/min) e cada canal pode ter até 5 drafts abertos.

---

## Pré-requisitos

- Docker e Docker Compose v2
- Node.js v25+ e npm (necessário no host apenas para testes E2E Playwright do frontend)

---

## Como rodar

As stacks de backend e frontend possuem arquivos `compose.yaml` independentes. Suba primeiro o backend e rode as migrations.

### 1. Backend (API + Worker + PostgreSQL + Mailpit + S3 Storage + Redis)

```bash
cd nestjs-project

# Crie o .env local caso ainda não exista
cp .env.example .env

# Sobe api, video-worker, db, mailpit, minio (pgsty/silo) e redis
docker compose up -d

# Instala dependências (apenas na primeira subida). O video-worker espera o
# node_modules existir ("waiting for npm install") e sobe sozinho em seguida.
docker compose exec nestjs-api npm install

# Executa as migrations (synchronize está desabilitado)
docker compose exec nestjs-api npm run migration:run

# Sobe a API em watch mode
docker compose exec -d nestjs-api npm run start:dev
```

> Ao testar upload multipart diretamente do host (`curl` ou browser), defina `S3_PUBLIC_ENDPOINT=http://localhost:9000` no `.env` para que as URLs pré-assinadas retornadas por `POST /videos/:id/uploads/parts` resolvam fora da rede interna do Docker. Volte para vazio antes de rodar os testes: as suítes rodam dentro do container `nestjs-api`, onde `localhost:9000` não é o storage.

Serviços disponíveis:

| Serviço | Endpoint / Porta | Observação |
|---|---|---|
| API NestJS | `http://localhost:3000` | Swagger opcional em `/api/docs` com `SWAGGER_ENABLED=true` |
| Video Worker | Container `video-worker` | Consome a fila BullMQ `video-processing` |
| PostgreSQL 17 | `localhost:5432` | `streamtube` / `streamtube` (os testes usam o banco `streamtube_test`) |
| Object Storage (S3 / Console) | `http://localhost:9000` / `http://localhost:9001` | Credenciais dev: `minioadmin` / `minioadmin` |
| Redis 7 | `localhost:6379` | Backend de filas BullMQ |
| Mailpit (UI SMTP) | `http://localhost:8025` | Captura e-mails transacionais em dev |

### 2. Frontend (Next.js BFF)

```bash
cd next-frontend
docker compose up -d
docker compose exec next-frontend npm install        # apenas na primeira subida
docker compose exec -d next-frontend npm run dev
```

Interface disponível em `http://localhost:3001` (acessa a API no host via `host.docker.internal:3000`).

---

## Endpoints da API

Requisições prontas para todo o fluxo (cadastro, upload multipart, status, stream, download, thumbnail): [`nestjs-project/api.http`](./nestjs-project/api.http), para a extensão REST Client do VS Code ou equivalente (para os `PUT` nas URLs pré-assinadas, veja a nota sobre `S3_PUBLIC_ENDPOINT` em [Como rodar](#1-backend-api--worker--postgresql--mailpit--s3-storage--redis)).

### Vídeos — Upload, Processamento e Entrega

| Método e Rota | Autenticação | Responsabilidade |
|---|---|---|
| `POST /videos/uploads/initiate` | JWT (10/min, até 5 drafts abertos) | Cria registro `draft`, gera `shortCode` único e abre multipart upload no S3 |
| `POST /videos/:id/uploads/parts` | JWT (dono do canal) | Emite URL pré-assinada `PUT` para uma parte específica do arquivo |
| `GET /videos/:id/uploads/parts` | JWT (dono do canal) | Lista as partes já enviadas com ETags, para retomar o upload |
| `POST /videos/:id/uploads/complete` | JWT (dono do canal) | Reserva o draft, confere o tamanho das partes, conclui o multipart, valida o objeto, muda para `processing` e enfileira o job |
| `POST /videos/:id/uploads/abort` | JWT (dono do canal) | Aborta o multipart no S3 e remove o `draft` (`409` se um `complete` chegou antes) |
| `GET /videos/me` | JWT | Lista vídeos do canal pertencente ao usuário autenticado |
| `GET /videos/:id/status` | JWT (dono do canal) | Retorna status atual, metadados extraídos e eventual `processingError` |
| `GET /videos/:shortCode` | Pública (`@Public()`) | Metadados públicos e URLs de stream, download e thumbnail (`404` enquanto não estiver `ready`) |
| `GET /videos/:shortCode/stream` | Pública (`@Public()`) | Mídia com HTTP `Range` (`206`), `ETag`/`304` e `If-Range`; `HEAD` responde sem abrir o storage |
| `GET /videos/:shortCode/download` | Pública (`@Public()`) | Download completo com `Content-Disposition: attachment` |
| `GET /videos/:shortCode/thumbnail` | Pública (`@Public()`) | Thumbnail JPEG (`image/jpeg`) gerada pelo `video-worker` |

### Autenticação e Canais

| Método e Rota | Responsabilidade |
|---|---|
| `POST /auth/register` | Cadastro de usuário e criação automática de canal 1:1 |
| `GET /auth/confirm-email?token=` | Confirmação de e-mail via token único |
| `POST /auth/resend-confirmation` | Reenvio de token de confirmação |
| `POST /auth/login` | Autenticação (access + refresh token) |
| `POST /auth/refresh` | Rotação de refresh token com family tracking e detecção de reuso |
| `POST /auth/logout` | Revogação dos refresh tokens da sessão |
| `POST /auth/forgot-password` | Disparo de token de recuperação de senha |
| `POST /auth/reset-password` | Redefinição de senha |
| `GET /auth/me` | Perfil do usuário autenticado |

Especificação OpenAPI atualizada em [nestjs-project/openapi.json](./nestjs-project/openapi.json) (`npm run openapi:export`).

---

## Testes e Verificações

### Backend (`nestjs-project`)

```bash
cd nestjs-project
docker compose exec -T nestjs-api npm test                 # unitários + integração reais
docker compose exec -T nestjs-api npm run test:e2e          # end-to-end HTTP via Supertest
docker compose exec -T nestjs-api npx tsc --noEmit          # checagem estrita de tipos
docker compose exec -T nestjs-api npm run lint              # ESLint (0 erros, 0 warnings)
docker compose exec -T nestjs-api npm run build             # build da API e do worker
```

Os testes de integração e E2E do módulo de vídeos rodam contra PostgreSQL, Redis, `pgsty/silo` (S3) e `ffmpeg` reais; só o envio SMTP (`MailService`) é mockado no E2E. As disputas de concorrência (concluir × cancelar, concluir × varredura, resposta perdida do S3) são forçadas nos testes de integração.

As suítes nunca tocam os dados de desenvolvimento: usam o banco `streamtube_test` e o bucket `streamtube-media-test`, que o `globalSetup` do Jest cria e migra com as mesmas migrations do `migration:run` (sem `synchronize`), e o prefixo BullMQ `streamtube-test`, então o `video-worker` do Compose nunca pega job de teste. A limpeza recusa qualquer banco cujo nome não termine em `_test`. As suítes rodam em série (`maxWorkers: 1`), porque compartilham o banco de teste.

### Frontend (`next-frontend`)

```bash
cd next-frontend
docker compose exec next-frontend npm test                  # Vitest + MSW
npx playwright test                                         # E2E no host (MSW_ENABLED=true)
```

---

## Estrutura do Repositório

```
.
├── docs/
│   ├── project-plan.md                        # Plano geral e escopo das entregas
│   ├── decisions/
│   │   └── technical-decisions-phase-03-videos.md
│   ├── diagrams/
│   │   └── software-arch.mermaid              # Diagrama C4 de containers
│   └── phases/
│       ├── phase-01-configuracao-base/
│       ├── phase-02-auth/
│       ├── phase-02-auth-frontend/
│       └── phase-03-videos/                   # Context, validation, library-refs, spec e progress
├── nestjs-project/
│   ├── src/
│   │   ├── auth/                              # JWT, Argon2, refresh rotation, throttler
│   │   ├── users/                             # Usuários
│   │   ├── channels/                          # Canais 1:1 por usuário
│   │   ├── mail/                              # Mailer + templates Handlebars
│   │   ├── storage/                           # S3StorageService (multipart, presign, byte-range)
│   │   ├── videos/                            # Upload, fila BullMQ, FFmpeg processor, streaming
│   │   ├── common/                            # DomainException, filtros e pipes
│   │   ├── config/                            # Schemas Joi e namespaces de configuração
│   │   ├── database/                          # DataSource e migrations TypeORM
│   │   ├── worker.main.ts                     # Bootstrap do video-worker
│   │   └── worker.module.ts                   # Módulo standalone do worker
│   ├── test/                                  # Suítes E2E
│   ├── compose.yaml
│   └── Dockerfile.dev                         # Node + FFmpeg/ffprobe
├── next-frontend/                             # App Router BFF, shadcn/ui, iron-session, Playwright
├── .agents/                                   # Skills, rules, sub-agents e exemplo de MCP (Antigravity)
├── .claude/                                   # Fundação equivalente para Claude Code
├── CLAUDE.md
├── GEMINI.md
├── FC Tube.fig
├── FC Tube sem padrão.fig
└── whiteboard.svg
```

---

## Como a fase foi conduzida (Antigravity + Gemini 4 Hydrogen)

A Fase 03 foi implementada no **Google Antigravity** com o **Gemini 4 Hydrogen** (`gemini-4-hydrogen-high`), seguindo o workflow do projeto. A fundação de IA de `.claude/` foi portada para a convenção do Antigravity: `.agents/skills/`, `.agents/rules/` (com `trigger: glob`, sem o qual o Antigravity descarta a rule em silêncio), sub-agents de leitura em `.agents/agents/` e [GEMINI.md](./GEMINI.md) / [nestjs-project/GEMINI.md](./nestjs-project/GEMINI.md) espelhando os `CLAUDE.md`. Os MCPs (Postgres e context7) estão em [.agents/mcp_config.example.json](./.agents/mcp_config.example.json); como instalar está no `GEMINI.md`.

| Etapa | Artefato |
|---|---|
| Decisões técnicas (7 TDs com alternativas e trade-offs) | [technical-decisions-phase-03-videos.md](./docs/decisions/technical-decisions-phase-03-videos.md) |
| Contexto e validação do plano (até `clean`) | [context.md](./docs/phases/phase-03-videos/context.md), [validation.md](./docs/phases/phase-03-videos/validation.md) |
| Referências das libs na versão instalada | [library-refs.md](./docs/phases/phase-03-videos/library-refs.md) |
| Plano (11 itens de implementação) | [phase-03-videos.md](./docs/phases/phase-03-videos/phase-03-videos.md) |
| Progresso, revisões e evidências | [progress.md](./docs/phases/phase-03-videos/progress.md) |

Depois da entrega, o código passou por revisão em par (construtor e auditor com papéis fixos, portão humano no fim de cada rodada). Nas rodadas 4 e 5, cada correção de comportamento entrou com um teste visto falhando antes dela:

| Rodada | Construtor → Auditor | O que entrou |
|---|---|---|
| 1 | Antigravity → Claude Code | Reprovada: `npm run lint` com 147 erros herdados do starter e MCP não portado. Correções escritas pelo Claude Code. |
| 2 e 3 | Claude Code → Antigravity | Auditoria dessas correções; falha no `HeadObject` depois do `complete` passou a terminar em `failed`. |
| 4 | Claude Code → Antigravity | Correções de um pente fino independente (Claude Fable 5.2): download com nome Unicode, SIGTERM no worker, demuxer forçado (SSRF), URLs fora dos erros, varredura, retomada de upload, rules portadas no formato que o Antigravity carrega. |
| 5 | Claude Code → Antigravity | Correções de uma revisão externa que reconstruiu a stack do zero: testes isolados do banco de dev, disputa concluir × cancelar, condicionais HTTP, worker que não sobrescreve estado final, teste real de 10 GiB. |

Achados, decisões e o que ficou de fora estão no [progress.md](./docs/phases/phase-03-videos/progress.md).

---

## Fases do produto

Este desafio entrega a **Fase 03** (backend: API, worker, infraestrutura e artefatos). As fases seguintes vêm do [`docs/project-plan.md`](./docs/project-plan.md) (Fases 04 a 07) e estão fora do escopo deste desafio.

| Módulo / Etapa | Escopo | Status |
|---|---|---|
| Base do Projeto | Monorepo Docker, NestJS 11, Next.js 16, TypeORM + PostgreSQL 17 | Concluída |
| Autenticação | Cadastro, confirmação SMTP, login, refresh rotation, reset de senha e BFF | Concluída |
| Upload e Processamento de Vídeos | Multipart S3 até 10 GiB, fila BullMQ/Redis, worker FFmpeg, thumbnail e streaming `206` | Concluída (Backend) |
| Gerenciamento de Vídeos e Canal | Edição de metadados, visibilidade e painel do canal | Planejada |
| Página de Visualização | Player integrado e página pública do vídeo | Planejada |
| Interações Sociais | Likes, comentários e inscrições | Planejada |
| Descoberta e Busca | Feed inicial, pesquisa e acabamento final | Planejada |

---

Repositório originado do template [devfullcycle/mba-ia-greenfield-project](https://github.com/devfullcycle/mba-ia-greenfield-project), onde constam o plano base e o design system (`FC Tube.fig`).
