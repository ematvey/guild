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
