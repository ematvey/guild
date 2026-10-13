# TS server rebuild on pi-durable — milestone plan

Date: 2026-10-04
Spec: `docs/specs/2026-10-04-ts-server-pi-durable-design.md`

Each milestone ends with its routes flipping from proxy to native TS. The
flip is the cutover; acceptance gates below must pass first. Conventions:
dev stack :18080, prod :18081 (repeat M7 there after dev stabilizes).

## M0 — shell

- `apps/server` workspace: Fastify app, config loading, logging, health route.
- Proxy-everything to the Rust server on an internal port (HTTP + WS upgrade).
- Compose wiring: TS container owns the public port; Rust server internal;
  TS image = node, TS embedded at build (no runtime transpile).
- CI: vitest run + typecheck for `apps/server`.
- Gate: dev stack serves the public port through the TS proxy with desktop
  + headless client smoke passing. Zero behavior change.

## M1 — platform core

- Postgres pool; schema access layer over the existing tables (verbatim).
- Auth: JWT session verify + issue (same secret/signing), login, OIDC
  login/callback, identity provisioning.
- Org context, error envelope, events feed (org activity), attachments (S3).
- Golden fixtures captured from Rust for auth + attachments wire formats.
- Gate: auth flows pass fixtures; headless client logs in against TS.

## M2 — gateway

- OpenAI-shaped + Anthropic-shaped endpoints, streaming included.
- Model routes, monthly quotas (ClickHouse month-to-date), org API keys.
- Internal API key mechanism for the agent runtime's loopback calls (used by
  M3; minted in config, never public).
- Gate: golden fixtures pass for both endpoint shapes; quota 429 path tested.

## M3 — agent runtime (the rebuild proper)

- Postgres storage backend for pi-durable (`durable_*` tables): portable
  core + node `pg` adapter, conformance suite from
  `@earendil-works/pi-durable/testing`, plus reopen-across-restart tests.
- Harness wiring: registry, extensions, coding tools, model provider over
  loopback gateway (internal key), usage sink to ClickHouse.
- Chats/threads/turns routes + SSE event frames via `watchEvents()`.
- Re-runnable thread importer: rebuild `durable_*` from `thread_events`,
  `chat_id → conversation_id` mapping; final run at this cutover.
- Auto-compaction enabled (settings), steering/follow-ups enabled.
- Restate container removed from compose.
- Gate: importer verified (row counts + spot checks + idempotent rerun);
  desktop + headless client run real turns against TS; SSE frames match
  captured fixtures.

## M4 — server-side workspace sessions

- Per-conversation `ExecutionEnv` rooted at `workspaces/<org>/<name>`.
- Exec-policy rule matcher ported to TS (rules stay static assets).
- Approval gates: `beforeTool` hook + durable waiting task resolved by the
  approval API; same audit trail.
- Tool artifacts + oversized-result spill per current behavior.
- Gate: `agent_sessions` flows pass vitest suite + smoke (write a file via
  a turn, approval block/resume works).

## M5 — hub machine links

- Machine-link WS protocol, byte-compatible with shipped daemons.
- Pairing, machine registry, live-slot rules (including the 0.5.25
  live-slot rejection behavior).
- Machine-tool dispatch: `ExecutionEnv` proxying through the hub.
- Gate: an existing desktop client (no update) links, shows online, and
  executes dispatched tools through the TS server; WS frame fixtures pass.

## M6 — long tail

- Registry (including integration items), releases/downloads, projects,
  teams, admin + web UI serving (embedded dist at build time).
- Gate: admin UI + web UI fully functional against TS; remaining proxy
  routes list is empty.

## M7 — retirement

- Remove proxy routes and the Rust server from dev compose; compose
  cleanup. Repeat the whole ladder for `~/guild-prod` (master branch).
- Post-parity work, separate plans: routines on pi-durable background
  tasks; subagents API.

## Working rules

- Branch `agent-plane` in `~/guild-wt-agent-plane`; conventional commits
  (`feat:`, `fix:`, `docs:`), no AI attribution lines.
- pi-durable pinned `1.0.1` — never forked, no upstreaming; workarounds live
  here (document each in the spec's decisions when one appears).
- Every milestone lands as one or more reviewable commits; PLAN.md gets a
  decision entry when a milestone lands.
