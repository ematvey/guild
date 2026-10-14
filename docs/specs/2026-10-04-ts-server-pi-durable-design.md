# TS server rebuild on pi-durable — design

Date: 2026-10-04
Status: approved (grilled with maintainer)

## Purpose

Rebuild the Guild cloud server (`crates/server`) in TypeScript, with the agent
runtime rebuilt on `@earendil-works/pi-durable`. The desktop app stays Tauri
(`guild-app-server` remains the local engine). Public API, platform concepts,
and data semantics stay the same. Restate is dropped.

## Decisions

1. **Full rewrite, staged.** Target is one TS server with no Rust server-side
   code left at the end. Ported area by area; the Rust server serves the rest
   during the transition and is retired at parity.
2. **Home: `apps/server`** in the guild monorepo (npm workspace `apps/*`).
3. **Cutover: TS in front.** The TS server owns the public port from M0 and
   reverse-proxies every un-ported route to the Rust server on an internal
   port (HTTP + WS upgrade). Each ported route flips to native TS. At parity
   the proxy and the Rust server are removed. Rollback per area: delete the
   TS route, the proxy resumes.
4. **Platform schema adopted verbatim.** The TS server implements the existing
   Postgres tables (`crates/server/migrations/*`) with the same column
   meanings, plus the same ClickHouse usage tables and S3/MinIO layouts. The
   Rust migration files remain the historical record. The only new tables are
   pi-durable's.
5. **Durable storage in the same database** (`guild` dev, `guild_prod` prod),
   tables namespaced `durable_*`: `durable_metadata`, `record_ids`,
   `conversations`, `entries`, `tasks`, `submissions`, `documents`,
   `document_revisions`. One connection pool.
6. **Thread history: one-time, re-runnable importer.** `thread_events` is an
   event log, not agent state; pi-durable needs its own entries/tasks/
   documents for resume, compaction, steering, and subagents. The importer
   maps `thread_events` transcripts to durable conversations
   (`chat_id → conversation_id` mapping) and is re-runnable during
   development to parity: each run rebuilds the durable store from
   `thread_events`. The final run happens at the chats-route cutover, after
   which `thread_events` freezes. `chat_reads` and the org activity feed
   (`events`) are UI-level state and stay as they are.
7. **Model access through the gateway, always.** The pi-durable harness uses
   an OpenAI-compatible provider pointed at the gateway's `/openai/v1`
   endpoint over loopback with an internal API key. Quotas, key vault, model
   routing, and usage recording stay in one place; the built-in agent is
   metered exactly like external clients.
8. **Routines: deferred.** Restate is dropped from compose when the agent
   runtime lands; routines become unreachable until ported later onto
   pi-durable background tasks (routine → conversation, run → background
   task, request ID = webhook idempotency). Routines are unused today
   (0 rows in dev).
9. **One Node process, one replica per stack.** The process owns HTTP, hub
   WS, gateway, timers, and the pi-durable harness (pi-durable storage allows
   exactly one owning process). Scale-out later = org sharding design.
10. **Framework: Fastify** with `@fastify/websocket` and `@fastify/http-proxy`.
11. **pi-durable: pinned `1.0.1`, never forked, no upstream fix loop.** Gaps
    and workarounds live Guild-side (the Postgres storage backend is the
    first example).
12. **Capabilities beyond parity included where additive:** automatic
    background compaction and steering/follow-ups are on at cutover where the
    API surface already fits; subagents come later as their own change.
13. **Parity acceptance (hybrid):** DB-backed vitest integration tests per
    route group (semantic), golden request/response fixtures for wire-format
    contracts (gateway endpoints, SSE event frames, hub WS frames), and a
    manual smoke (headless client + desktop) before each route group flips.

## Concept mapping

| Today (Rust)                    | TS server on pi-durable                                   |
| ------------------------------- | --------------------------------------------------------- |
| chats + thread_events           | pi-durable conversations (durable storage)                |
| agent loop (guild-core port)    | pi-durable generation/tool tasks, built-in coding tools   |
| server-side sessions (M6)       | conversations with per-conversation `ExecutionEnv` on `workspaces/<org>/<name>` |
| exec policy + approvals         | `beforeTool` hooks + durable waiting task resolved by the approval API |
| machine dispatch via hub        | `ExecutionEnv` proxying through the hub WS to the daemon  |
| SSE turn frames                 | `watchEvents()` → same SSE frame contract                 |
| routines on Restate             | (deferred) background tasks + request IDs                 |
| compaction checkpoints          | pi-durable compaction (auto per decision 12)              |
| usage recording                 | `pi.usage` docs → existing ClickHouse sink                |
| `agent_sessions` rows           | unchanged metadata rows; run state moves to durable storage |

Forced compat requirements (not decisions): hub WS frames byte-compatible
(existing daemons never update), JWT session tokens verify/issue identically,
web UI/admin dist embedded at build time as today.

## Amendments

- **2026-10-04 (M0): session tokens are opaque, not JWT.** The Rust server
  issues random bearer tokens stored only as sha256 hashes in the
  `sessions` table (with `auth_generation` stamping) — there is no JWT
  anywhere. The "JWT session tokens" compat requirement above means: the TS
  server must accept/issue the same opaque-token + `sessions`-row +
  auth-generation mechanism, identically.
- **2026-10-04 (M4/M6): parity deviations accepted at the harness seam.**
  (a) pi-durable's CodingTools tail-cap tool output at 50 KiB, so the
  64 KiB oversized-result spill is ported (store + routes + bridge) but not
  reachable end-to-end through the built-in tool set — machine-tool results
  still hit it; (b) model-facing durable context keeps full tool content
  (Rust compacts it too) — spill affects only the journaled event +
  download route; (c) the approval gate waits by polling journaled
  decisions rather than a literal pi-durable child task — same
  block/resume/recovery semantics; (d) live deltas are event-driven
  (pi-durable partial commits ≤100 ms) instead of Rust's 100 ms poll — same
  cadence floor; no ToolCallDelta/Done stream frames (pi-durable streams
  argument growth as JSON-path patches — shapes don't map; tool calls
  surface as Started/Completed); (e) disconnect settle of pending machine
  dispatches is immediate (Rust: 15s grace watcher); (f) web dist is served
  from the TS image at runtime (Dockerfile stage) instead of Rust's
  include_dir embed; asset hashes differ per build (fresh SPA build),
  serving semantics match. Evidence: reports M4/M6.
- **2026-10-04 (M3 storage core): pi-durable 1.0.1 gaps worked around
  Guild-side** (all in `docs/reviews/2026-10-04-ts-server-port/src/storage/postgres/`, no forking):
  (a) `idFromNumber`/`seqFromNumber` not exported → branded-type casts at
  trusted boundaries; (b) JSONB can't hold lone surrogates → records and
  document revisions stored as JSON text, parsed in the core (matches the
  pinned SQLite reference); (c) node-postgres returns BIGINT as strings →
  global INT8 type parser returning `Number` (durable ids/seqs stay in
  safe-integer range; no other BIGINT consumers yet); (d) runtime dep
  `@earendil-works/chord ^1.0.1` added for document-delta application, same
  as pi-durable's own backends; (e) commits additionally take `FOR UPDATE`
  on the `durable_metadata` row so two storage instances over one DB can
  never interleave (belt-and-braces on top of decision 9's single-owner
  rule). Evidence: 23/23 conformance cases, reopen-across-restart tests,
  benchmarks in `docs/reviews/2026-10-04-ts-server-port/M3-STORAGE-REPORT.md`.

## Process model

Single Node process per stack. Owns: Fastify HTTP, hub WS server, gateway,
interval timers, the pi-durable harness with its scheduler. Compose: TS
server container takes the public port (:18080 dev, :18081 prod); Rust server
moves to an internal port until retirement; Restate container removed at M3.
