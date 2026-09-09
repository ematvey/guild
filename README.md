# Guild

Self-hosted replacement for OpenAI Codex / Claude Cowork at the organization
level. Orgs own their data and their LLM resources.

- **Desktop client** — Tauri v2 (`apps/desktop`): minimal codex/cowork-style UI.
- **Local engine** — `guild-app-server` (`crates/app-server`): agent loop,
  tools, MCP; talks to the UI over stdio JSON-RPC and to the cloud over HTTPS.
- **Cloud server** — `guild-server` (`crates/server`): auth (managed + OIDC),
  LLM gateway (OpenAI-shaped + Anthropic-shaped), chat history, org registry,
  integrations runtime (Restate), web UI.

Spec: `docs/specs/2026-09-09-guild-design.md`.

## Layout

```
crates/protocol     shared types (JSON-RPC + cloud API)
crates/guild-core   agent loop, tools, provider clients
crates/app-server   local engine binary
crates/server       cloud server (api + worker roles)
apps/desktop        Tauri desktop client
apps/webui          web UI (later milestone)
deploy/compose      docker compose bundle
docs/specs          design docs
docs/plans          implementation plans
```

## Build & test

```bash
cargo fmt --all
cargo test --workspace
cargo test -p guild-server --features test-support   # includes testcontainer tests
cargo clippy --workspace -- -D warnings
```

## Run the stack

See `deploy/README.md` (docker compose: guild-server, Postgres, ClickHouse,
MinIO, Restate).

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

## Server-side workspace sessions (execution backend, M6)

The server can run the agent loop against a per-org workspace directory
(`$GUILD_DATA_DIR/workspaces/<org>/<name>`), with file/git tools enabled and
`run_command` disabled unless `GUILD_ALLOW_SHELL_TOOLS=1`:

```bash
curl -X POST localhost:8080/api/v1/agents/sessions -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"workspace_name":"repo-a"}'
curl -N -X POST localhost:8080/api/v1/agents/sessions/<id>/turns \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"message":"write a hello.py","model":"gpt-4o-mini"}'   # SSE frames
```

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
- **Generated TS types** (§6): `crates/protocol/ts/**` is generated with
  `TS_RS_EXPORT_DIR=ts cargo test -p protocol --features ts`; do not edit by
  hand.
