# Guild

Self-hosted replacement for OpenAI Codex / Claude Cowork at the organization
level. Orgs own their data and their LLM resources.

- **Desktop client** — Tauri v2 (`apps/desktop`): minimal codex/cowork-style UI.
- **Local engine** — `guild-app-server` (`crates/app-server`): runs the
  tools the server dispatches over the machine link, context prepare, skills
  sync and the local file bridge; agent turns run server-side. Hosted
  in-process by the desktop app; CLI verbs reach it over a local socket.
- **Cloud server** — TypeScript Fastify app (`apps/server`) on
  `@earendil-works/pi-durable`: auth (managed + OIDC), LLM gateway
  (OpenAI-shaped + Anthropic-shaped), chats/turns (durable conversations),
  hub machine links, org registry, releases, integrations tool API, web UI.

TS-server rebuild design: `docs/specs/2026-10-04-ts-server-pi-durable-design.md`.

## Layout

```
crates/protocol     shared types (JSON-RPC + cloud API)
crates/guild-core   tools, registry bundle codec
crates/app-server   local engine binary
apps/server         TS cloud server (Fastify + pi-durable) + SQL migrations
apps/desktop        Tauri desktop client (also the web SPA)
packages/wire       hand-written TypeScript wire types (server + desktop)
packages/integration-sdk  integration plugin contract, helpers, guild-plugin CLI
packages/ui         shared component kit
packages/genui      Generated UI: OpenUI component library + prompt (server + desktop)
protocol            wire schemas (the contract), fixtures, check.mjs
deploy/compose      docker compose bundle
docs/specs          design docs
docs/plans          implementation plans
docs/archive        older decision log
```

## Build & test

`scripts/check.sh` is the one gate. It runs the baseline checks concurrently,
prints PASS/FAIL and the time for each, then a summary. It exits 1 if any
check fails. It needs `cargo-nextest` (`cargo install cargo-nextest`).

```bash
scripts/check.sh              # the full gate
scripts/check.sh --fast       # skip cargo test and the server suite
scripts/check.sh --only coherence
```

The gate runs these checks concurrently:

```bash
cargo nextest run --workspace
npm test --workspace apps/server        # TS server suite (disposable PG/CH databases)
cd apps/desktop && npm test             # frontend vitest
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
./node_modules/.bin/biome ci .          # TS/JS format + lint (biome.json)
scripts/check-windows.sh                # SKIP when the Windows target is absent
node protocol/check.mjs                 # schema ↔ wire types ↔ fixtures, and compatibility with the last client release
npm run coherence
npx tsc -p <project>/tsconfig.json --noEmit   # typecheck: apps/server, apps/desktop, packages/wire, packages/ui, packages/genui, packages/integration-sdk
```

`--fast` keeps everything but `cargo nextest` and the server suite, so the
typecheck runs in both modes. Vitest strips types without checking them;
the `typecheck` check is the only place `tsc` sees the TypeScript trees.

Format before you commit: `cargo fmt --all` and
`./node_modules/.bin/biome check --write .` (the gate runs `cargo fmt --check`
and `biome ci`; `biome.json` holds the TypeScript format and lint rules).

## Run the stack

See `deploy/README.md` (docker compose: the TS server, Postgres,
ClickHouse, rustfs).

## Headless client

```bash
cargo run -p guild-app-server -- login --url http://localhost:8080 \
  --email admin@example.org --password '<password>'
cargo run -p guild-app-server -- chat --model gpt-4o-mini "hello"
```

## Desktop app

```bash
cd apps/desktop && npm install   # the engine is a library linked into the desktop binary
npm run tauri dev
```

## Agent routines

A routine belongs to a persistent agent: a prompt on a schedule. `kind` is
`cron` (a five-field cron expression, or interval sugar such as
`every 30m`, minimum one minute, in `timezone`, default UTC) or `once`
(`run_at`). The scheduler in the server process claims each due occurrence
and starts an isolated agent run; there are no webhook triggers.

```bash
curl -X POST localhost:8080/api/v1/agents/$AGENT/routines \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"digest","kind":"cron","schedule":"0 9 * * 1-5","prompt":"Digest the inbox."}'
# run it now, and read its runs:
curl -X POST localhost:8080/api/v1/agents/$AGENT/routines/$ROUTINE/run -H "authorization: Bearer $TOKEN"
curl localhost:8080/api/v1/agents/$AGENT/routines/$ROUTINE/runs -H "authorization: Bearer $TOKEN"
```

`GET`/`PATCH`/`DELETE /api/v1/agents/:id/routines/:rid` read, change and
remove one routine (`apps/server/src/platform/http/agents.ts`).

## Public OpenAI-compatible endpoint

```bash
# admins issue an org API key (plaintext shown once):
curl -X POST localhost:8080/api/v1/admin/api-keys -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"name":"ci"}'
# then any OpenAI client works against the org gateway:
curl -X POST localhost:8080/openai/v1/chat/completions \
  -H "authorization: Bearer gk_..." -H 'content-type: application/json' \
  -d '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"hi"}],"stream":true}'
```

## Persistent agents

Named agents own a durable workspace, threads, and routines. The design is in
`docs/specs/2026-10-18-persistent-agents.md`.

## Client builds & distribution

Single client binary (GUI + engine in one executable) packaged as a Windows
NSIS installer, a Linux AppImage, and macOS DMGs — cross-built on Linux,
published to the server's release registry and updater manifest,
minisign-signed. Full process: `docs/clients.md`.

## SSO, quotas, attachments, events

- **OIDC SSO**: admins configure the org IdP via
  `PUT /api/v1/admin/oidc {issuer, client_id, client_secret}`; browser login
  starts at `GET /api/v1/auth/oidc/login?org_id=…` (302 to the IdP), the
  callback provisions `identity_type=oidc` members on first login and issues
  a normal session.
- **Model route quotas**: `PUT /api/v1/admin/gateway/routes` accepts
  `quota_monthly_usd`; the gateway returns 429 `quota_exceeded` once
  month-to-date ClickHouse spend reaches the cap.
- **Attachments**: `POST /api/v1/chats/{id}/attachments?filename=…`
  (raw body), list + org-scoped download via `/api/v1/attachments/{id}`;
  bytes live in object storage.
- **Registry `integration` items**: `POST
  /api/v1/registry/integration/{slug}/install` installs an MCP plugin
  bundle (a `manifest.json` with an `mcp` block) as a disabled org
  integration; an admin enables it and sets its secrets. A bundle that
  carries a `routine.json` is refused.
- **Org events**: written to the `events` table and fanned out over
  Postgres LISTEN/NOTIFY to the member WebSocket as `org_event` frames;
  `GET /api/v1/events` returns the latest 200. Emitted on registry
  publish/update/unpublish/fork, skill install/uninstall/pin, and member
  join.
- **Wire types**: `protocol/*.schema.json` is the contract. The TypeScript
  types are hand-written from it in `packages/wire`, the Rust types in
  `crates/protocol/src`. Nothing generates either side.

### Promote a queued message to steering

While an agent runs, queued message chips offer **Steer now**. This keeps the
message identity and delivers it at the next tool boundary. The session-auth
endpoint is `POST /api/v1/threads/:chatId/pending/:messageId/steer` (empty body,
or `{}` with JSON content type). It returns `{ "steering": true }`, or 409
when the message has already been placed or admission is still pending.
