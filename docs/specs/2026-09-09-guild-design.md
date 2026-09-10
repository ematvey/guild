# Guild — Design Spec

Date: 2026-09-09
Status: draft for review

## 1. Overview

Guild is a self-hosted replacement for OpenAI Codex / Claude Cowork at the
organization level. Orgs own their data (chat history, skills, integration
configs) and their LLM resources (provider keys, usage, cost control) instead
of handing both to a vendor.

Two main components:

- **Client** — a minimalistic Tauri desktop app (codex/cowork clone).
- **Server** — a Rust backend that acts as: backend API, LLM gateway, and a
  shared org registry for skills, MCP servers, and integrations. It ships a
  built-in web UI.

### Goals (v1)

1. Chat that stays in-house: users chat with models through the org gateway;
   history is stored on the org server.
2. A coding agent on the desktop: repo-aware agent loop with file/command/git
   tools and approvals, model calls routed through the org gateway.
3. Team workspace: orgs, teams, users (managed accounts + OIDC SSO), shared
   registries, per-user/team/model cost tracking.
4. Server-executed integrations: webhooks, schedules, user-created routines,
   running as durable agent loops on Restate.

### Non-goals (v1)

- Server-side code execution with repo checkouts (later "execution backend"
  milestone; the protocol is designed so it slots in).
- Public OpenAI-compatible API endpoint on the guild-server (later milestone;
  gateway internals are built so only the public surface is added).
- Kubernetes/Helm packaging (compose now; nothing assumes a single process).
- Full sandboxing of desktop tool execution beyond OS-native options.

## 2. System overview

Four components plus shared protocol:

- **guild-app** (Tauri v2; React + TypeScript + shadcn/ui) — desktop client.
  Pure viewer/editor: session list, chat/agent view, approvals, settings.
  No agent logic.
- **guild-app-server** (Rust binary, launched by the desktop app) — local
  engine. Runs the agent loop, executes tools, hosts MCP clients, talks to
  the UI over JSON-RPC (stdio) and to the cloud over HTTPS.
- **guild-server** (Rust, axum) — the org's cloud backend: identity/auth,
  LLM gateway, session/history storage, registry, integrations runtime,
  admin API, built-in web UI.
- **guild-core** (shared Rust crate) — agent loop, tool definitions,
  provider client types, protocol types. Used by guild-app-server now;
  reusable later by a headless CLI and by server-side agent workers.
- **protocol** (shared types, Rust crate + generated TS) — the local
  JSON-RPC protocol and the cloud REST API schemas.

Flow:

```
guild-app (React UI)
   ↕ JSON-RPC over stdio
guild-app-server (local engine, guild-core)
   ↕ HTTPS + SSE
guild-server (axum API tier)
   ├→ Postgres        (records: identity, sessions, registry, queues)
   ├→ ClickHouse      (usage events with costs)
   ├→ S3-compatible   (skill bundles, attachments, artifacts)
   ├→ Restate         (durable agent loops, routines, integrations)
   └→ model providers (OpenAI-shaped, Anthropic-shaped adapters)
```

Data ownership: chats, keys, skills, integration configs live on the
guild-server. Code work stays on the user's machine.

## 3. Client

### 3.1 guild-app (Tauri v2)

- React + TypeScript + shadcn/ui.
- Screens: session list; chat/agent view (streaming text, tool calls, diffs);
  approval prompts (run command / edit file / MCP tool); settings (server
  URL, login, tool policy); registry browser (install skills, MCP configs).
- Attaches to the per-user guild daemon over a local socket (spawns it
  detached on first use); JSON-RPC line protocol per §6. The daemon
  survives window closure (§3.3) — sessions always keep running; no
  keep-alive prompt is needed.
  > 2026-09-10: changed from child-process engine to a surviving per-user
  > daemon — milestone-8 plan (`docs/plans/2026-09-10-milestone-8-daemon.md`).
- Login flow: OAuth-style browser flow against the guild-server (managed
  account or OIDC SSO — the client does not distinguish); token storage in
  the OS keychain via Tauri.

### 3.2 guild-app-server (local engine)

Responsibilities:

- **Agent loop** (guild-core): plan → call model through the cloud gateway →
  execute tools → feed results back → repeat, until done or user stops.
- **Tools**: read/write/edit files, run commands (scoped, approval-gated),
  git, glob/grep. Sandboxed where the OS makes it cheap; deep sandboxing is
  an execution-backend concern, not v1.
- **Approvals**: per-tool policy (always / never / ask), per session and per
  project directory. Approvals are UI interactions via JSON-RPC.
- **MCP clients**: connect to configured MCP servers (local stdio and remote
  HTTP), expose their tools to the agent alongside built-ins.
- **Cloud client**: login and token refresh, streaming model calls through
  the gateway, session/history sync (server is source of truth; local cache
  for offline reads).
- **Skills**: installs skill bundles from the org registry into a local
  skills directory; the agent loads them like codex/cowork skills
  (SKILL.md format).

Offline behavior: model calls require the server (the gateway is the only
path to providers), so no model work offline. Local file tools still work;
history reads come from cache.

### 3.3 Why a local app-server process

- Sessions keep running when the window is closed or hidden.
- Tool execution is native Rust — fast, no UI process coupling.
- The same app-server binary can later run headless (CI, scheduled local
  runs) and the web UI can attach to remote execution backends.

## 4. Cloud server (guild-server)

One axum binary, role flags (`api`, `worker`); stateless API tier, N
replicas behind a load balancer.

### 4.1 Identity and auth

- `orgs`, `users` (role: admin | member), `teams` + `team_members`.
- Two login paths into one session model:
  - Managed accounts: email + password (argon2).
  - OIDC SSO: generic OIDC against the org's IdP (Entra, Okta, Google
    Workspace, Keycloak).
- Sessions: opaque tokens, DB-backed, revocable.
- Client tokens carry user + org + team context for metering and access.

### 4.2 LLM gateway

- Internal API used by guild-app-server only (no public endpoint in v1).
- Two provider adapters: **OpenAI-shaped** and **Anthropic-shaped**; all
  supported providers conform to one or the other.
- Streaming end-to-end (SSE from provider through server to client).
- Provider keys are **org-level, stored server-side, never sent to
  clients**. Encrypted at rest with a master key from config (KMS later).
- Model routing table per org: which models are exposed, via which
  provider, with quotas.
- Every request emits a usage event (see 4.5). Cost per request is recorded
  at request time (token counts × org-configured price per model).

### 4.3 Sessions and history

- Chats, messages (role, content, tool calls, cost), attachments.
- Postgres is the source of truth; large content in object storage with
  references in Postgres.
- Desktop client syncs against the server; the web UI reads the same data.
- Restate holds only the **active subset**: an in-flight agent loop's
  journal (current step, pending calls). On completion, results are
  persisted to Postgres and the Restate journal retires.

### 4.4 Registry

Org-scoped catalogs. Three item kinds:

- **skills** — SKILL.md bundles (tarball/zip in object storage, metadata in
  Postgres). Reuses the existing agent-skills ecosystem; Guild-specific
  metadata (id, version, review status, dependencies) lives in a separate
  manifest, not inside SKILL.md.
- **mcp** — MCP server configs + metadata (how to launch/connect, scope).
- **integrations** — config + manifest; installing one activates its
  trigger on the server (see 4.6).

Lifecycle: publish (from the client, or via CLI) → version → review status
(draft/approved) → install. Users publish; admins review; installs pull
from the registry. Skill publishing from guild-app-server is a first-class
flow ("publish my skills to the org registry").

### 4.5 Cost tracking

- Every model request writes a `usage_event` to ClickHouse: org, user,
  team, model, provider, tokens (in/out), cost, timestamp, session ref.
- Message rows in Postgres carry their cost field, joined at write time.
- Dashboards and APIs query ClickHouse directly: per user, per team, per
  model, per day. No roll-up tables; ClickHouse answers roll-ups fast at
  any scale.
- Org-level quotas (e.g., monthly budget per team) are enforced in the
  gateway by checking recent usage.

### 4.6 Integrations runtime (Restate)

Restate is the durable execution runtime for server-side work. Guild worker
services (Rust, Restate SDK) run beside it:

- **Triggers**:
  - inbound webhooks (per-integration URL on the guild-server; forwarded as
    durable one-way sends),
  - schedules/cron (Restate durable timers; self-scheduling virtual
    objects),
  - org events (skill published, member joined, ...).
- **Handlers run durable ReAct agent loops** (guild-core on the Restate Rust
  SDK): each loop journaled, resumable after crash, model calls through the
  guild-server's own gateway. Postgres remains the record system — Restate
  journals hold only the active subset (see 4.3).
- **Actions available to routines/integrations in v1**: call a model
  (through the gateway), call external HTTP APIs (Slack, GitHub, ...),
  read/write object storage, emit events to subscribed clients. No
  server-side repo tool execution in v1.
- **User-created routines** are registry-backed configuration: a routine is
  a (trigger, agent prompt/tool set, action) triple, created by users in the
  web UI or from the client, executed durably.
- Retries: Restate default retry policies; non-retryable failures marked
  terminal and surfaced in the web UI's runs view.

### 4.7 Web UI

Bundled React app served by axum (same stack as the client):

- Admin console: users/teams, provider keys, model routes, registry review,
  usage/cost dashboards, integration runs.
- Light chat client: read org sessions, continue chats in the browser.
- Login via the same identity system.

### 4.8 Scalability

- API tier stateless; N replicas behind a load balancer (compose runs one;
  k8s scales to N with no code change).
- Realtime fan-out (web UI live updates, agent status) via a pub/sub path —
  Postgres LISTEN/NOTIFY now, NATS later if needed.
- Restate is itself horizontally scalable (partitioned journal); workers are
  stateless services that scale by replica count.
- Postgres, ClickHouse, object storage are all external and clusterable.
- Single binary + compose stays the small-org default; nothing in the code
  assumes one process.

### 4.9 Deployment

- Docker compose bundle: guild-server (api + worker roles), Restate,
  Postgres, ClickHouse, MinIO. One config file.
- Kubernetes/Helm later.

## 5. Data model

Postgres (records):

- `orgs`, `teams`, `team_members`, `users` (identity_type: managed|oidc,
  role), `sessions`, `oidc_configs`
- `provider_keys` (org, provider, encrypted secret), `model_routes`
  (org, model, provider, enabled, quota)
- `chats`, `messages` (chat, role, content, tool_calls, cost, usage ref),
  `attachments` (object storage refs)
- `registry_items` (org, kind: skill|mcp|integration, slug, latest version,
  review status), `registry_versions` (version, manifest, object ref),
  `routines` (org, trigger config, agent config, action config, enabled)
- Outbox/webhook bookkeeping tables as needed for the integration runtime.

ClickHouse:

- `usage_events`: timestamp, org, team, user, session, model, provider,
  tokens_in, tokens_out, cost, request_id.

S3-compatible objects:

- skill bundles, attachments, large artifacts (diffs, logs).

Restate state:

- journal of in-flight agent loops / routines only; retired on completion.
  No long-term records live exclusively in Restate.

## 6. Protocols

- **UI ↔ app-server**: JSON-RPC over stdio. Request methods + server-push
  events for streaming. Versioned from day one (`protocol` field in every
  envelope) — the web UI and future headless uses depend on shape
  stability. Types defined once in the `protocol` crate; TS types generated.
- **app-server ↔ cloud**: HTTPS REST under `/api/v1/...`, SSE for model
  streaming, token auth. Schemas versioned with the API.
- **Registry payloads**: skills keep SKILL.md + files in a tarball; a
  manifest JSON alongside carries guild-specific fields (id, version,
  review status, dependencies).
- **guild-server internal**: the API tier invokes Restate services over
  Restate ingress; Restate workers call back into the API tier for gateway
  calls (they are the same deployment's internal API).

## 7. Error handling

- Typed error enums per crate; no stringly errors crossing boundaries.
- HTTP: one error envelope for `/api/v1` (code, message, details).
- JSON-RPC: standard error codes plus app codes; protocol errors are
  distinguishable from tool errors.
- Agent tool failures are surfaced to the model as tool results (the agent
  can react), not crashes. Crashes in the local engine: the UI reconnects
  and resumes the session view from history.
- Restate loops: retryable errors retried by Restate; terminal errors end
  the run and are visible in the runs view.

## 8. Testing

- Protocol round-trip tests (Rust ↔ TS types stay in lockstep).
- Gateway adapters against recorded provider fixtures plus optional live
  smoke tests.
- Restate worker logic: replay tests (forced journal replay) so handler
  changes that break determinism fail in CI.
- Integration runtime: fake provider + fake webhook end-to-end.
- Server API: integration tests against Postgres/ClickHouse test
  containers.
- UI: manual for v1; Playwright later.

## 9. Repo layout

```
guild/
  crates/
    protocol/        # shared types: local JSON-RPC + cloud API schemas
    guild-core/      # agent loop, tools, provider client types
    app-server/      # local engine binary
    server/          # cloud server: api tier + worker services
  apps/
    desktop/         # Tauri v2 app (React + TS + shadcn)
    webui/           # web UI served by guild-server (React + TS + shadcn)
  deploy/
    compose/         # docker compose bundle + config
  docs/
    specs/           # this spec, ADRs
```

## 10. Milestones

1. **Skeleton round-trip** — workspace scaffolding; both binaries run;
   login (managed account); one chat round-trip through the gateway with
   streaming; history persisted.
2. **Desktop agent** — agent loop, built-in tools, approvals, MCP client,
   local skills loading.
3. **Registry** — skills + MCP publish/install/versioning, CLI publishing.
4. **Web UI** — admin console, usage dashboards, light chat.
5. **Integrations runtime** — Restate worker tier, webhooks, schedules,
   user-created routines with model-call + HTTP actions.
6. **Execution backends** — server-side sandboxed repo execution as an
   additional backend; public OpenAI-compatible gateway endpoint.
