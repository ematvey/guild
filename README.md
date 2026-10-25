# Guild

Self-hosted replacement for OpenAI Codex / Claude Cowork at the organization
level. Orgs own their data and their LLM resources.

- **Desktop client** — Tauri v2 (`apps/desktop`): minimal codex/cowork-style UI.
- **Local engine** — `guild-app-server` (`crates/app-server`): agent loop,
  tools, MCP; talks to the UI over stdio JSON-RPC and to the cloud over HTTPS.
- **Cloud server** — TypeScript Fastify app (`apps/server`) on
  `@earendil-works/pi-durable`: auth (managed + OIDC), LLM gateway
  (OpenAI-shaped + Anthropic-shaped), chats/turns (durable conversations),
  hub machine links, org registry, releases, integrations tool API, web UI.

TS-server rebuild design: `docs/specs/2026-10-04-ts-server-pi-durable-design.md`.

## Layout

```
crates/protocol     shared types (JSON-RPC + cloud API)
crates/guild-core   agent loop, tools, provider clients
crates/app-server   local engine binary
apps/server         TS cloud server (Fastify + pi-durable) + SQL migrations
apps/desktop        Tauri desktop client (also the web SPA)
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

The gate runs, in this order of dependency (the bindings check waits for
cargo test, because cargo test rewrites the generated bindings):

```bash
cargo nextest run --workspace
npm test --workspace apps/server        # TS server suite (disposable PG/CH databases)
cd apps/desktop && npm test             # frontend vitest
cargo clippy --workspace --all-targets -- -D warnings
scripts/check-windows.sh                # SKIP when the Windows target is absent
scripts/check-bindings.sh               # runs after cargo test
npm run coherence
```

Format before you commit: `cargo fmt --all`.

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
cargo build -p guild-app-server          # the engine, found automatically
cd apps/desktop && npm install
npm run tauri dev
```

## Integrations (routines, M5)

User-created routines run as durable ReAct loops on Restate (webhook or
interval triggers, `http_call` / `storage_put` actions):

```bash
curl -X POST localhost:8080/api/v1/routines -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"slug":"digest","trigger_kind":"webhook","prompt":"Digest it.","model":"gpt-4o-mini"}'
# fire it:
curl -X POST localhost:8080/api/v1/hooks/<org>/<slug> \
  -H "x-guild-hook-token: <webhook_token>" -d '{"headline":"hi"}'
```

## Public OpenAI-compatible endpoint (M6)

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

## SSO, quotas, attachments, events (M7)

- **OIDC SSO** (§4.1): admins configure the org IdP via
  `PUT /api/v1/admin/oidc {issuer, client_id, client_secret}`; browser login
  starts at `GET /api/v1/auth/oidc/login?org_id=…` (302 to the IdP), the
  callback provisions `identity_type=oidc` members on first login and issues
  a normal session.
- **Model route quotas** (§4.5): `PUT /api/v1/admin/gateway/routes` accepts
  `quota_monthly_usd`; the gateway returns 429 `quota_exceeded` once
  month-to-date ClickHouse spend reaches the cap.
- **Attachments** (§4.3): `POST /api/v1/chats/{id}/attachments?filename=…`
  (raw body), list + org-scoped download via `/api/v1/attachments/{id}`;
  bytes live in object storage.
- **Registry `integration` items** (§4.4): `POST
  /api/v1/registry/integration/{slug}/install` reads the bundle's
  `routine.json` and creates a disabled routine — enable it via the routines
  API to activate the trigger.
- **Org events** (§4.6/§4.8): published to the `events` table and fanned out
  over Postgres LISTEN/NOTIFY; subscribe with
  `GET /api/v1/events/stream` (SSE) or read recent events from
  `GET /api/v1/events`. Emitted on skill publish and member join today.
- **Generated TS types** (§6): `crates/protocol/bindings/**` is generated
  with `cargo test -p protocol --features ts` (freshness check:
  `scripts/check-bindings.sh`); do not edit by hand.

### Promote a queued message to steering

While an agent runs, queued message chips offer **Steer now**. This keeps the
message identity and delivers it at the next tool boundary. The session-auth
endpoint is `POST /api/v1/threads/:chatId/pending/:messageId/steer` (empty body,
or `{}` with JSON content type). It returns `{ "steering": true }`, or 409
when the message has already been placed or admission is still pending.
