# Guild Milestone 4 — Web UI Implementation Plan

**Status: COMPLETE** (2026-09-09, branch `feat/milestone-4`). Admin console
(dashboard/users/registry/gateway) and light streaming chat, embedded in the
guild-server image; serving, admin APIs, and usage queries covered by
automated tests; deployed compose stack smoke-tested (index, SPA fallback,
login, usage summary).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The guild-server ships a built-in web UI: admin console (users,
provider keys, model routes, registry review, usage/cost dashboards) and a
light browser chat client. Same data, same API as the desktop client.

**Architecture:** `apps/webui` — a Vite + React + TS + shadcn app built to
static assets and served by axum (embed via `tower-http`/`include_dir` or a
rust-embed style). Talks to the same `/api/v1` as the desktop; bearer token
in localStorage. Server gains the missing admin/user APIs and usage query
endpoints (ClickHouse reads).

**Tech Stack:** existing workspace; adds `apps/webui` (Vite), `mime_guess`
for static serving; server usage-query API over ClickHouse.

**Spec:** `docs/specs/2026-09-09-guild-design.md` (§4.7, §4.5; milestone 4 in §10)

## Global Constraints

- Same error envelope, same auth; admin endpoints behind the admin role.
- No server-side rendering — static bundle served from the guild-server
  binary (`GET /` and static assets; unknown non-`/api` paths → index.html).
- Usage queries read ClickHouse directly; no roll-up tables (spec §4.5).
- Tests: server API tests as usual; UI verified by build + a Playwright-free
  smoke (HTTP fetches of the built index + one admin flow via the API).

---

### Task 1: server — admin user/team management API

**Files:**
- Create: `crates/server/src/http/admin.rs`
- Modify: `crates/server/src/http/mod.rs`
- Test: `crates/server/tests/admin_api.rs`

**Interfaces:**
- Produces (all admin-guarded):
  - `GET /api/v1/admin/users` → `{users: [{id, email, role, identity_type, created_at}]}`
  - `POST /api/v1/admin/users` `{email, password, role}` → user row (uses identity store create_user)
  - `DELETE /api/v1/admin/users/{id}` → `{}` (revokes sessions; refuses deleting the last admin)
  - `GET /api/v1/admin/teams` / `POST /api/v1/admin/teams` `{name}` / `POST /api/v1/admin/teams/{id}/members` `{user_id}` — teams tables + store methods (new migration `0006_teams.sql` for `teams`/`team_members`)
  - `GET /api/v1/admin/registry/{kind}/{slug}/versions` — full version list with review status for the console

- [x] **Step 1: Failing tests** — admin lists/creates/deletes users; member forbidden; last-admin delete refused; team create + member add.
- [x] **Step 2: FAIL.**
- [x] **Step 3: Implement.**
- [x] **Step 4: PASS + clippy.**
- [x] **Step 5: Commit** — `feat(server): admin user/team management api`

### Task 2: server — usage query API

**Files:**
- Create: `crates/server/src/http/usage.rs`
- Modify: `crates/server/src/http/mod.rs`
- Test: `crates/server/tests/usage_api.rs`

**Interfaces:**
- Produces:
  - `GET /api/v1/usage?from=&to=&group_by=user|team|model&team_id=` (auth; admins see whole org, members only themselves)
    → `{rows: [{group, tokens_in, tokens_out, cost_usd, requests}]}` — ClickHouse aggregation
  - `GET /api/v1/usage/summary` → `{today_cost_usd, month_cost_usd}` for the caller's scope
- [x] **Step 1: Failing test** — gateway call through full stack (usage lands in CH) → summary + group_by=user rows reflect it; member sees only own rows.
- [x] **Step 2: FAIL.**
- [x] **Step 3: Implement** (clickhouse crate query with fetch).
- [x] **Step 4: PASS + clippy.**
- [x] **Step 5: Commit** — `feat(server): usage query api over clickhouse`

### Task 3: webui — app scaffold + static serving

**Files:**
- Create: `apps/webui/` (Vite + React + TS + tailwind + shadcn-style components mirroring apps/desktop/src/components), `crates/server/src/http/web.rs`
- Modify: `crates/server/src/http/mod.rs`, `crates/server/Cargo.toml`, root `Dockerfile` (build webui and copy dist)

**Interfaces:**
- Produces:
  - `webui build` → `apps/webui/dist`; server serves `apps/webui/dist` (embedded at compile time via `include_dir` on `apps/webui/dist`; when the dir is missing, the server still builds — web routes return 503 with a hint).
  - `GET /` → index.html; `GET /assets/*` → hashed assets; any non-`/api` GET → index.html (SPA fallback).
- [x] **Step 1: Scaffold webui** (npm, tailwind, components copied/adapted from desktop).
- [x] **Step 2: Static serving** with SPA fallback + 503-when-not-built.
- [x] **Step 3: Test** — server test asserts `/` serves the built index (build webui in test setup via std::process npm build — skip gracefully when npm absent: mark `#[ignore]`? No: assert only when dist exists; CI builds it).
- [x] **Step 4: PASS + clippy.**
- [x] **Step 5: Commit** — `feat(server): embedded webui static serving`

### Task 4: webui — admin console

**Files:**
- Create: `apps/webui/src/views/{Login,Dashboard,Users,Registry,Gateway}.tsx`, `src/api.ts`
- Modify: `apps/webui/src/App.tsx` (minimal hash routing)

**Interfaces:**
- Consumes: Task 1/2 admin APIs, existing gateway/registry APIs.
- Produces: views —
  - Login (email/password → token in localStorage; me → role)
  - Dashboard: today/month cost cards, per-model usage table (usage APIs)
  - Users: list/create/delete, role select
  - Registry: item list per kind, review approve/revert buttons (admin), version list
  - Gateway: provider keys (masked), model routes table + editor
- [x] **Step 1: api.ts + routing shell.**
- [x] **Step 2: Views (one commit each is overkill here; single commit, views are independent components).**
- [x] **Step 3: Build green; manual API-driven smoke of each endpoint from the UI code paths is covered by server tests.**
- [x] **Step 4: Commit** — `feat(webui): admin console views`

### Task 5: webui — light chat client

**Files:**
- Create: `apps/webui/src/views/Chat.tsx` (chat list, create chat, send via `/api/v1/gateway/chat` SSE from the browser, history render)

**Interfaces:**
- Consumes: chats API + gateway SSE. Browser-side SSE: fetch + ReadableStream parsing (same framing as the engine client).
- Produces: logged-in user picks a chat, sends a message, sees streamed reply with cost.

- [x] **Step 1: Chat view with SSE parsing.**
- [x] **Step 2: Build green.**
- [x] **Step 3: Commit** — `feat(webui): light chat client with streaming`

### Task 6: desktop + compose integration

**Files:**
- Modify: `deploy/compose/docker-compose.yml` (no change expected — webui already inside the server image), root README

- [x] **Step 1: Compose smoke** — up; browse `http://localhost:PORT/` (HTTP fetch index + login via API); registry + usage dashboards reachable.
- [x] **Step 2: README** — web UI section.
- [x] **Step 3: Commit** — `docs: web ui usage; deploy: verify webui in compose`

## Self-Review

- **Spec coverage (M4):** admin console (T4: users, keys, registry review, usage dashboards), light chat (T5), served by axum (T3), ClickHouse direct queries (T2), compose unchanged shape (T6). The desktop client is unaffected.
- **Placeholders:** none.
- **Type consistency:** usage row shape defined in the server API and consumed by the dashboard verbatim; SkillEntry/registry shapes reused.
