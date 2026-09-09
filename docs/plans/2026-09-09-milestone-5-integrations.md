# Status: COMPLETE

(completed on feat/milestone-5; see git log for task commits. Compose E2E verified: webhook routine succeeded end-to-end through Restate; interval chain runs every tick and stops when disabled. Restate 1.7 admin API path is /deployments — worker listens before registering so the probe succeeds.)

# Guild Milestone 5 — Integrations Runtime (Restate) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-executed integrations: user-created routines (webhook or
interval triggered) run as durable ReAct agent loops on Restate; actions are
model calls via the gateway, external HTTP calls, and object-storage writes;
runs are recorded and visible via API.

**Architecture:** `guild-server --role worker` (default role `all` in dev/
compose) hosts the Restate endpoint (port 9080) with a `RoutineRunner`
virtual object keyed by routine id. Webhooks are forwarded by the API tier
to Restate ingress fire-and-forget (`.../handle_webhook/send`). Interval
routines self-schedule via delayed `tick` sends; the loop reads `enabled`
from Postgres each tick and stops when disabled. Each nondeterministic step
(routine load, run record, model call, HTTP action, storage write) is
journaled with `ctx.run`. Model calls go through an internal completion API
(guarded by a static internal token; usage attributed to the routine's
creator). Restate discovery: worker registers its endpoint with the Restate
admin API at startup (retrying until reachable).

**Tech Stack:** `restate-sdk = "0.12"` (features: default + reqwest-client);
compose already ships Restate.

**Spec:** `docs/specs/2026-09-09-guild-design.md` (§4.6, §4.8, §5; milestone 5 in §10)

## Global Constraints

- No user code or repo tool execution server-side in v1 (spec §4.6).
- Durable journaling: every side effect inside `ctx.run`; no raw time/random
  in handlers (SDK rules).
- The internal API (`/api/v1/internal/*`) requires `GUILD_INTERNAL_TOKEN`
  (Bearer); it never exposes provider keys.
- A broken routine (terminal failure) must not block others: failures land
  in the run record with status `failed`; the interval loop keeps ticking.
- Tests: server + worker logic against testcontainers/wiremock; the
  Restate-in-the-loop E2E is verified in the compose smoke (Task 5) and an
  `#[ignore]`-marked integration test for local runs.

---

### Task 1: schema + routine CRUD + internal APIs

**Files:**
- Create: `crates/server/migrations/0007_routines.sql`, `crates/server/src/store/routines.rs`, `crates/server/src/http/internal.rs`
- Modify: `crates/server/src/http/mod.rs`, `crates/server/src/store/mod.rs`, `crates/server/src/config.rs`
- Test: `crates/server/tests/routines_api.rs`

**Interfaces:**
- Schema `0007_routines.sql`: `routines` (id, org_id, created_by, slug UNIQUE(org,slug), name, trigger_kind webhook|interval, trigger_config jsonb, prompt, model, allowed_tools jsonb, webhook_token, enabled, created_at) + `routine_runs` (id, routine_id, trigger, status running|succeeded|failed, summary, error, started_at, finished_at).
- `store::routines::RoutineStore`: create/get_by_slug/list/update(enabled, prompt, model...)/delete/record_run_started → run_id/mark_run_finished/list_runs.
- HTTP (auth): `POST/GET/PATCH/DELETE /api/v1/routines` (+ `GET /{id}/runs`).
- HTTP (internal, Bearer GUILD_INTERNAL_TOKEN):
  - `GET /api/v1/internal/routines/{id}` → full config (org, creator, prompt, model, tools, enabled, webhook_token)
  - `POST /api/v1/internal/runs` `{routine_id, trigger, summary?, error?, status, started_at, finished_at?}` → `{run_id}` (started_at+status=running when finished_at absent)
  - `POST /api/v1/internal/completion` `{org_id, user_id, model, system?, messages, tools?}` → SSE StreamEvents; usage attributed (org, user); NO chat persistence
  - `POST /api/v1/internal/storage` `{org_id, key, content}` → object storage put under `runs/{org}/{key}`
- `POST /api/v1/hooks/{org_id}/{routine_slug}` — header `x-guild-hook-token` must match the routine's token → `202 {}`; forwards fire-and-forget to Restate ingress `{GUILD_RESTATE_URL}/RoutineRunner/{routine_id}/handle_webhook/send` with `{}` body (400 if routine missing/disabled).
- Config: `GUILD_RESTATE_URL` (default `http://localhost:8080`), `GUILD_INTERNAL_TOKEN` (required for worker mode; optional if no worker), `GUILD_WORKER_ADVERTISED_URL` (default `http://localhost:9080`), `GUILD_WORKER_BIND` (default `0.0.0.0:9080`).

- [ ] **Step 1: Failing tests** — routine CRUD (member creates, admin lists all); hook auth (wrong token 401, unknown slug 404) + forwarding body seen by a wiremock restate; internal completion round-trip via scripted provider records usage and no chat rows; internal runs records list via `/api/v1/routines/{id}/runs`; internal storage put lands in MinIO.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: PASS + clippy.**
- [ ] **Step 5: Commit** — `feat(server): routines, webhook forwarding, internal worker api`

### Task 2: worker — routine executor (plain, testable)

**Files:**
- Create: `crates/server/src/worker/mod.rs`, `crates/server/src/worker/executor.rs`
- Test: `crates/server/tests/executor.rs`

**Interfaces:**
- Produces:
  - `worker::RoutineExecutor { api_base, internal_token, reqwest }`:
    - `load_config(routine_id) -> RoutineConfig` (GET internal/routines)
    - `start_run(routine_id, trigger) -> RunHandle { run_id, started_at }`
    - `finish_run(run_id, status, summary?, error?)`
    - `completion(org, user, model, system, messages, tools) -> (text, Vec<ToolCall>)` — consumes the internal completion SSE into the final frame set (same mapping as the client GatewayTurn)
    - `http_call(url, method, body) -> (status, body)` — HTTPS-only in prod, HTTP allowed when `GUILD_WORKER_ALLOW_HTTP=1` (tests)
    - `storage_put(org, key, content)`
  - `worker::run_routine(exec, routine_id, trigger, payload) -> Result<summary>` — the full loop: load config → start run → up to `max_steps` (10) completion calls with tools `[http_call, storage_put]` (built from a `ToolRegistry` of worker tools implementing guild-core `Tool` against the executor) → finish run. Tool failures become tool-result messages (model-readable), never abort.
- [ ] **Step 1: Failing test** — wiremock internal API + scripted completion: a routine that calls http_call then concludes; run record transitions running→succeeded with the summary; a failing http_call becomes a tool message and the loop still finishes.
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: PASS + clippy.**
- [ ] **Step 5: Commit** — `feat(server): routine executor with journaled-action tool set`

### Task 3: worker — Restate bindings + registration

**Files:**
- Modify: `crates/server/src/worker/mod.rs` (RoutineRunner object + registration), `crates/server/src/main.rs` (role dispatch), `crates/server/src/lib.rs` (`worker_entry`)
- Modify: `crates/server/Cargo.toml` (restate-sdk)
- Test: `crates/server/tests/worker_registration.rs` (mock restate admin) + `#[ignore]` full-Loop test

**Interfaces:**
- Produces:
  - `#[restate_sdk::object] RoutineRunner`:
    - `handle_webhook(ctx, Json<Value>)` — one run per webhook delivery
    - `tick(ctx, Json<u64 /*interval_secs*/>)` — run + delayed self-send (`send_after`), stops when disabled (DB read journaled)
  - `worker_entry(cfg)` — registers `http://{advertised}` with the Restate admin API (`POST {restate_admin}/endpoints`, retry until 2xx/409), then `HttpServer::listen_and_serve(bind)`.
  - Role dispatch: `GUILD_ROLE` = `api` | `worker` | `all` (default `all`: spawn worker entry, then serve the API).
- [ ] **Step 1: Failing test** — registration posts the advertised URL and retries on connection failure (wiremock admin, first N responses 503); role=all boots both (probe internal port).
- [ ] **Step 2: FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: PASS + clippy; `#[ignore]` restate E2E compiles.**
- [ ] **Step 5: Commit** — `feat(server): restate bindings for routines with registration and roles`

### Task 4: compose + smoke E2E

**Files:**
- Modify: `deploy/compose/docker-compose.yml`, `deploy/compose/config.env.example`, `deploy/README.md`

**Interfaces:**
- Compose: server env gains `GUILD_RESTATE_URL=http://restate:8080`, `GUILD_INTERNAL_TOKEN`, `GUILD_WORKER_ADVERTISED_URL=http://server:9080`, `GUILD_WORKER_BIND=0.0.0.0:9080`; server publishes 9080 → host (optional).
- Smoke: up → create routine (interval 5s, prompt that asks the model to call http_call against the server's own health endpoint) → webhook fire → run recorded `succeeded`; then `down -v`.

- [ ] **Step 1: Update compose/env/README.**
- [ ] **Step 2: Run smoke; record output.**
- [ ] **Step 3: Commit** — `deploy: restate worker in compose; docs: routine smoke`

## Self-Review

- **Spec coverage (M5):** webhooks (T1), interval/cron via durable timers (T3), user-created routines with registry-backed config (T1), durable ReAct loops journaled per step with Postgres as record system and only active state in Restate (T2/T3), actions = model call + external HTTP + storage + runs-as-events (T1/T2), worker pool horizontally scalable (virtual objects keyed per routine; worker role separate — T3), Restate in compose since M1 (T4).
- **Placeholders:** none.
- **Type consistency:** `RoutineConfig` single source in worker/executor.rs, loaded via internal API; runs status strings fixed in migration CHECK.
