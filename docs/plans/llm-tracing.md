# LLM Observability — full in-app tracing stored in ClickHouse

## Problem

Every LLM call (model inference, approval judge) already meters into
ClickHouse `usage_events` (one row per gateway call: tokens, cost,
request_id), and judge verdicts journal onto approval cards. But there is
no queryable observability: no caller identity (a judge row is only
recognizable by its ~335-token signature), no durations, no verdicts, no
prompt/completion payloads, no linkage between a judge call and the tool
call that triggered it. Debugging incidents like the starved-judge one
(2026-10-14, `max_tokens` starvation hid behind a broken log) required
archaeology across pino logs and container lifecycles.

## Goal

Full-cycle, in-app observability for admins and team members:

1. **Storage** — every LLM call traced in ClickHouse with full metadata
   (caller, cause, duration, verdict, tokens incl. reasoning) and
   opt-in request/response payloads.
2. **Backend** — the gateway and the judge emit traces; graceful
   degradation when ClickHouse is unreachable (never fail a request).
3. **API** — admin (org-wide) and member (own-calls) query endpoints.
4. **UI** — an Observability section in settings: summary cards,
   filterable call table, row detail with payloads.
5. **E2E** — unit tests + a live compose-stack verification (turn with a
   gated tool → model + judge rows in ClickHouse → API → UI).

## Non-goals

- No changes to `usage_events` (Rust-owned DDL) — the new tables are
  TS-owned; `llm_calls.request_id` joins `usage_events.request_id`.
- No Rust daemon changes.
- No sampling/retention tuning beyond TTLs.

---

## 1. Storage (ClickHouse)

TS-owned, idempotent DDL run by the sink on first use (same pattern as
`UsageSink.ensure`), tables in the `guild` database.

```sql
CREATE TABLE IF NOT EXISTS guild.llm_calls (
  ts                DateTime,
  request_id        UUID,                -- = usage_events.request_id
  org_id            UUID,
  user_id           UUID,
  team_id           Nullable(UUID),
  session_id        UUID,                -- gateway auth session
  chat_id           Nullable(UUID),      -- caller-supplied context
  conversation_id   Nullable(Int64),
  turn              Nullable(Int32),
  caller            LowCardinality(String),  -- 'model' | 'judge'
  cause             LowCardinality(String) DEFAULT '',  -- e.g. 'turn-step', 'approval-gate:hubspot_api:<call_id>'
  model             String,
  provider          String,
  tokens_in         UInt32,
  tokens_out        UInt32,
  reasoning_tokens  UInt32           DEFAULT 0,
  cost_usd          Float64          DEFAULT 0,
  duration_ms       UInt32,
  finish_reason     LowCardinality(String) DEFAULT '',
  stream            Bool                 DEFAULT true,
  error             String               DEFAULT '',
  verdict           Nullable(Bool),      -- judge only
  verdict_reason    String           DEFAULT '',
  prompt_chars      UInt32           DEFAULT 0,
  completion_chars  UInt32           DEFAULT 0
) ENGINE = MergeTree
  PARTITION BY toYYYYMM(ts)
  ORDER BY (org_id, ts)
  TTL toDateTime(ts) + INTERVAL 90 DAY;
```

```sql
CREATE TABLE IF NOT EXISTS guild.llm_payloads (
  ts          DateTime,
  request_id  UUID,
  org_id      UUID,
  kind        LowCardinality(String),  -- 'request' | 'response'
  body        String CODEC(ZSTD(3))
) ENGINE = MergeTree
  PARTITION BY toYYYYMM(ts)
  ORDER BY (request_id, kind)
  TTL toDateTime(ts) + INTERVAL 14 DAY;
```

Payload storage is opt-in: `GUILD_TRACE_PAYLOADS=1` (default off —
conversations in ClickHouse must be a deliberate choice). TTLs make
retention self-managing.

## 2. Backend emission

**Contract:** the gateway inserts rows for ordinary (model) calls; judge
calls are self-reported by the judge (the gateway cannot know the
verdict it hasn't parsed). The gateway skips recording rows for requests
carrying the internal-caller marker.

- `platform/http/openai.ts` (the gateway endpoint):
  - measures `duration_ms` per request;
  - extracts tokens, `finish_reason`, `reasoning_tokens`
    (`usage.completion_tokens_details.reasoning_tokens` when the
    upstream reports it), `cost_usd` (existing `usageCostUsd`);
  - reads context headers: `x-guild-internal-caller`,
    `x-guild-chat-id`, `x-guild-conversation-id`, `x-guild-turn`,
    `x-guild-cause`;
  - requests WITH `x-guild-internal-caller` are NOT recorded here (the
    caller self-reports); all others insert `caller='model'` rows;
  - payload bodies (request JSON, accumulated completion) recorded to
    `llm_payloads` when enabled.
- `harness/approvals.ts` (the judge): after parsing the verdict, inserts
  its own `llm_calls` row (`caller='judge'`, `cause='approval-gate:<tool>:<call_id>'`,
  `chat_id`, `verdict`, `verdict_reason`, tokens from the response JSON)
  + payloads when enabled. A failed/unreachable sink never affects the
  gate (same degradation rules as the usage sink).
- `harness/models.ts` (the provider client): forwards
  `x-guild-chat-id` / `x-guild-conversation-id` / `x-guild-turn` headers
  on the loopback model calls — `GuildRuntime.submitTurn` supplies the
  context (it knows chat/conversation/turn); the machine- and
  client-dispatched model calls also ride the gateway, so the same
  headers flow for those lanes where the context is known.

## 3. API

- `GET /api/v1/admin/observability/calls` — filters
  `from,to,caller,model,chat_id,limit(≤500),offset`; returns rows
  (payloads NOT included — fetched per-row) + total count.
- `GET /api/v1/admin/observability/summary` — per-day × caller
  aggregates: calls, tokens in/out, reasoning tokens, cost, p50/p95
  duration.
- `GET /api/v1/admin/observability/calls/:request_id/payloads` — the
  stored request/response bodies (admin only).
- Team observability: `GET /api/v1/observability/calls` +
  `/summary` — identical handlers, force-scoped to the caller's
  `user_id` (members see their own calls; admins the org). Payload
  endpoints stay admin-only.
- Authz: admin endpoints behind the existing admin guard; member
  endpoints require a user session and always scope by it. No org id
  from the client is ever trusted.

## 4. Frontend (apps/desktop)

- New settings section **Observability** with its own URL per the
  routing convention (settings sub-page, deep-linkable, back/forward
  correct — follow `skills-route.ts` as the reference for the contract).
- Admin view: summary cards (calls, tokens, cost, judge approvals —
  today/7d/30d toggle), filter bar (time range, caller, model, chat),
  virtualized call table, row drawer → metadata + payloads (admin).
- Member view: the same components scoped to self (their own calls), no
  payloads, no cost columns beyond their own spend.
- The section renders an explicit "tracing disabled" empty state when
  `llm_calls` has no rows for the window (ClickHouse down or payloads
  off must be distinguishable in the UI copy).

## 5. Tests + E2E

- Unit (vitest): sink DDL + row mapping; gateway header parsing +
  skip-when-internal-caller; judge self-report (verdict row exists,
  cause carries the tool call); API authz (member scoping, admin
  org-wide); URL routing of the new section.
- Live compose E2E (dev stack, `:18080`):
  1. submit a turn that calls a gated tool (hubspot read) →
  2. assert `llm_calls` gained a `model` row and a `judge` row with
     `verdict=true` and `cause` carrying the tool call id (clickhouse-client);
  3. assert the admin API returns both rows and the summary aggregates;
  4. agent-browser smoke of the Observability section (deep link,
     filters, row drawer).
- Record the recipe + results in `PLAN.md` (newest entry on top) per
  repo convention.

## 6. Rollout

- Deploy to dev (compose rebuild recipe in `docs/deploy-nuances.md` §2),
  verify, leave payloads OFF by default; flip `GUILD_TRACE_PAYLOADS=1`
  on dev only for the E2E and keep it on (14-day TTL bounds it).
- Merge back: the worktree branch `tracing/llm-observability` → develop
  after verification; prod deploy is a separate decision.

## Conventions (binding for the implementation)

- All navigation state is URL state (AGENTS.md).
- `PLAN.md` is the decision log: add an entry describing what was built
  and why (newest on top) — no history narration in code comments.
- Redeploy after changes; verify via `/api/v1/health` + the live checks
  above.
- `cargo test -p protocol` must stay green (no protocol changes expected;
  if bindings are touched, run `scripts/check-bindings.sh`).
- Concurrency: other sessions work in `~/guild` — this worktree is
  isolated; do not touch `~/guild` or `~/guild-prod` checkouts, only
  read them for reference.
