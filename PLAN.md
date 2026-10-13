# PLAN — current state and future directions

Guild is a self-hosted Codex/Cowork replacement: a Rust workspace (cloud
server, local engine, shared protocol/core crates) plus a Tauri desktop
client. Product requirements live in `docs/PRD.md`, system contracts in
`docs/SRS.md`, deploy recipes in `docs/deploy-nuances.md`, client release
recipes in `docs/clients.md`. Repo conventions are in `AGENTS.md`.

This file tracks where the project stands and where it is going. History is
not kept here — it lives in git and in `docs/reviews/`.

## Latest decisions

- **User-owned MCP servers + the codemode tool (0.5.40, 2026-10-14).** Two
  branches merged (`user-mcp`, `codemode`), both built by subagents in their
  own worktrees and browser-E2E-verified live on :18080.
  *User MCP*: members add their own streamable-HTTP MCP servers in Settings
  → MCP servers (list/add dialog with live probe/detail with enable toggle
  and delete); the server stores name/url/headers (headers encrypted with
  the org master key, API returns masked previews only), migration 0068,
  CRUD+probe routes user-session-authed with an SSRF guard rejecting
  private/loopback IP literals unless `GUILD_MCP_ALLOW_PRIVATE=1` (set in
  the dev compose config.env — flip it off for stricter behavior; DNS names
  are never resolved, so `host.docker.internal` passes). At turn start the
  chat owner's enabled servers are discovered (`listTools`) and their tools
  declared as `mcp_<server>_<tool>`, executed server-side per call with
  headers re-decrypted at call time; an unreachable server degrades to a
  prompt-index diagnostic, never a failed turn.
  *Codemode*: pi-durable upgraded 1.0.1 → 1.2.0 (breaking changes absorbed:
  Postgres storage scan-order/error semantics per the conformance suite,
  `ToolExecutionResult.content` → `output`, tagged tool-task unions,
  ChatBridge ignoring the new event fields; wire contracts unchanged). Every
  conversation now carries the `codemode` tool (`createCodemodeExtension`):
  the model writes JavaScript that runs in a QuickJS sandbox and calls the
  conversation's tools as nested calls (`tools.read`, `tools.bash`, skills
  and MCP tools too) — only the script's output reaches the model. Nested
  calls run the full tool pipeline (validation, hooks, exec policy, approval
  gate) exactly like direct calls. E2E: MCP probe + real-model turn
  (`mcp_e2efixture_add(2,3)` → `5`), codemode write→read script round-trip
  plus a correctly policy-blocked nested bash; SSRF deny path verified live.
- **Descriptions are one line, stored and rendered (2026-10-14).** The
  detail page's apparent line breaks were the `max-w-[560px]` render cap
  wrapping — the stored value was already single-line. Save points now
  collapse whitespace regardless: `singleLineDescription` (new, in
  `registry-manifest.ts`) normalizes the editor create/edit/fork fields
  and the push_skill derivation, and the desktop `parseFrontmatter` folds
  literal block scalars flat too — descriptions feed one-line index
  entries and a multi-line value would corrupt that format.
- **Publish parses the SKILL.md description; publish auto-installs (2026-10-14).**
  `descriptionFromSkillMd` (server push path) now reads the frontmatter's
  `description` first — single-line plain/quoted, block scalars (`>`/`|`
  with chomping indicators, folded with spaces vs kept newlines), and a
  bare key with indented continuation lines — falling back to the old
  first-body-line heuristic (which had grabbed the opening `---` fence as
  the description). Desktop `parseFrontmatter` (composer local-skill
  descriptions) reads block scalars the same way. Publishing auto-installs
  for the publisher in all three paths (editor create, fork, edit; agent
  push_skill): the same install record + `skill.installed` event + machine
  sync a manual install takes, pinned at the published version; a later
  publish by the same user re-pins them to it, other users' pins are
  untouched (their update-available marker works as before). The live
  `hubspot-investigate` row's description and manifest were corrected in
  place, and the pusher got their retroactive install record.
- **Rail tabs own URLs; tab switch resets the composer (2026-10-13).**
  Each sidebar tab now has its own address: `/chats` (default, `/` aliases
  to it), `/work` (also implied by `/project/<id>`), `/settings` (bare;
  sectioned `/settings/<section>` URLs remain the settings overlay, whose
  root-less form now canonicalizes to `/settings/account` because bare
  `/settings` is the tab). Tab picks navigate via pushRoute, so back/forward
  walks tab history and reloads/deep links restore the tab from the URL —
  the localStorage tab persistence is gone. Navigating to a tab root clears
  the open chat: switching Chats ↔ Work (or any tab) always lands on a fresh
  composer, never the previously selected chat. `ChatRoute` gained a `tab`
  field; `chatRoutePath` takes it as a fifth parameter.
- **Org-wide skills shipped (2026-10-13).** The 17-task plan
  (`docs/superpowers/plans/2026-10-13-org-skills.md`, spec
  `docs/superpowers/specs/2026-10-13-org-skills-design.md`) is complete and
  deployed: registry items gain team/owner ownership, maintainer gating and
  tombstone unpublish (revival via the editor route republishes at
  max-version+1); skill HTTP surface (catalog, detail with read_stats,
  source, install/uninstall/pin/gate/unpublish, fork, activity,
  member-scoped `/skills/teams`, caller-install listing `/skills/installs`);
  ClickHouse `skill_reads` sink feeding detail-page usage stats; agent tools
  `read_skill` (install-on-use, pinned, sha-verified) / `search_skills` /
  `push_skill` with one combined index section in the system prompt
  (8192-byte budget); `skills.sync_v1` MachineRequest converging pinned
  installs onto every machine (Rust app-server handler materializes to
  `~/.agents/skills/`, sidecar `agents/guild.yaml`, per-entry isolation);
  desktop Skills rail panel (catalog/activity tabs, detail with
  install/pin/fork/gate/unpublish, wiki-style editor with owner pick,
  Tauri-only local-machine group); composer mentions cover local + installed
  org skills only; settings' SkillsSection deleted (panel owns skill
  customization), RegistrySection keeps mcp/integration. Startup now applies
  `apps/server/migrations` via `schema_history` (the old by-hand ritual is
  retired). Branch `skills`, E2E verified live on :18080 (create -> read ->
  install-on-use pin -> panel counts -> activity feed).

- **Rust server deleted (2026-10-13).** `crates/server` git-rm'd — the R9
  gate (prod cutover + soak) superseded by maintainer's explicit order after
  the live E2E on the TS stack (real model turn with tool calls through the
  server-side sandbox, usage sink verified, wire parity diffed against the
  retired Rust image on a loopback port: all GET surfaces identical except
  TS's additive `org_id`/`user_id` on projects). Migrations moved to
  `apps/server/migrations` (the TS test harnesses were the only remaining
  reader of `crates/server/migrations`); the root `Dockerfile` (Rust image)
  deleted; provenance comments naming the Rust tree cleaned across the TS
  sources; README/AGENTS/deploy docs updated. Consequences: the dev stack
  is TS-only (:18080), prod (:18081) still runs the Rust server from its
  own checkout (`~/guild-live`) until its cutover — rollback for prod is a
  checkout of git history, not a build from this tree. Workspace now:
  protocol, guild-core, app-server, codex-execpolicy(+utils), desktop
  Tauri.

## Latest decisions- **Sidebar icon rail — chats and project chats separated.** The chat
  sidebar grew a ChatGPT-desktop-style narrow icon rail (desktop only,
  always visible even when the panel is collapsed) with three tabs:
  Chats (workspace switcher, New chat, Recents, Archived), Work (projects
  with their fold-out chats), Settings (section rows that open the settings
  overlay at that section). The account menu moved to the rail bottom; the
  tab selection persists in `localStorage["guild.sidebarTab"]`. Recents
  now shows only stateless chats — project-bound chats appear only under
  their project on the Work tab (project rows carry an aggregate
  unread/generating dot, and `/project/<id>` deep links open the Work tab).
  The mobile drawer is pinned to the Chats panel (no rail there).
  `sidebarGrouping.visible` changed meaning accordingly (stateless only).

- **0.5.36 — read markers ride event `seq`, not event id.** Threads with a
  dead executor kept reappearing unread after every refresh: durable
  workflow events carry deterministic uuid v5 ids (idempotent replay), and
  the unread derivation compared event ids bytewise assuming uuid v7
  time ordering — an older event with a bytewise-greater v5 id counted
  unread forever, no matter how often the chat was opened. Migration 0066
  moves `chat_reads` to `last_read_seq BIGINT` (the global write order the
  marker already selected from), backfills from the stored ids, and the
  list projection + mark_read compare in seq space. Migrations are
  append-only: 0048 keeps its shipped schema, 0066 alone does the
  transform (editing 0048 broke fresh template builds with a duplicate
  column). Server-only; no client change.

- **Prod is a separate checkout** (`~/guild-live`, branch master, compose
  stack on :18081, public at guild.example.org). Deploy to prod by
  fast-forwarding its master from ~/guild's develop (fetch the local path,
  merge --ff-only — its docker-compose.yml carries prod-local edits, so
  never rebase it) and `docker compose build server && up -d` there. First
  multi-workspace deploy: 0.5.32 on 2026-09-30. The 0.5.22→0.5.32 jump
  exposed that an untracked migration file breaks the tree — migrations
  must be committed with their store/mod.rs entries.

- **Multi-workspace auth — the daemon holds N live sessions, one per
  server.** The desktop client can now be signed into two guild servers
  (different domains) at once and switch between them: both servers see the
  machine online and either can dispatch tools. Design spec:
  `docs/plans/2026-09-30-multi-workspace-auth-design.md` (approved:
  "both live simultaneously", not Slack-style single-active switching).
  Mechanics: `workspaces.json` (session list + active pointer) beside
  `token.json`, which stays the ACTIVE session's mirror so the watcher,
  CLI logins, and every reader keep working. The single machine-link
  channel became a registry (one link task per live workspace, supervisor
  per host cycle). New RPC: `workspace.list`, `workspace.switch`;
  `session.clear` gained an optional `base_url` (per-workspace sign-out).
  Webview: workspace switcher in the account menu, "Add workspace" shows
  the pair/sign-in card over the running app; switching re-mirrors
  `session.info` and reloads (the existing restore path). Accepted
  consequence: one machine's executor serves two servers concurrently —
  dispatches are independent requests, the executor processes them one at
  a time. Machine slots are per-server, so the 0.5.25 live-slot rule is
  unaffected. A dead token in one workspace keeps its row listed as "sign
  in again" instead of vanishing.

- **0.5.25 — a live machine slot is held, not displaced.** Root cause of the
  recurring devbox outages: any locally-run guild binary (dev sessions on
  this box — which IS devbox) loads the real token.json and connects a
  machine link as the same row; the hub's newest-wins displacement handed
  the slot to the thief, and the displaced link never learns it lost the
  slot — its leftover server conn keeps heartbeating, so the daemon sits
  "connected" while the machine shows offline until the daemon restarts.
  The hub now REJECTS a connect from a different instance while a live slot
  exists (same-instance reconnects still replace their own zombie slot —
  that's the blip-heal path); clients of every deployed version already
  park 300s on the Displaced notice and retry. Rejections are logged with
  machine + instance. Known limit: instance_id is client-claimed, so a
  determined spoofer could still bypass — real defense would need
  per-instance credentials. Server-only change; no client release needed.

- **0.5.24 — the Windows machines were offline because of one misplaced
  flag.** WORKSTATION's daemon trace (the 0.5.23 toggle earning its keep) showed
  `daemon host cycle failed: os error 87` once per second: the Sep 23 pipe
  rewrite passed `PIPE_REJECT_REMOTE_CLIENTS` in `dwOpenMode` where the bit
  is unassigned, so `CreateNamedPipeW` failed on every call and the host
  cycle aborted + respawned the machine link once a second — no Windows
  client could hold a link past ~1s (WORKSTATION, DEVBOX-2), while the
  Linux daemon path never runs this code. Flag moved to `dwPipeMode`; the
  reclaiming host also no longer tears the link down on a failed bind (the
  link is independent of the CLI socket — the Sep 23 abort+respawn shape
  was the storm's other half). Lesson that keeps paying: the Sep 25
  instrumentation + the 0.5.23 trace toggle turned "why is it offline"
  into a one-line answer without touching the user's machine.

- **Desktop 0.5.35 released (2026-10-04).** `scripts/release-clients.sh` run
  detached (systemd user unit, warm caches — 3.5 min wall) against the dev
  server; all four platforms published and server-side sha256-verified:
  Windows NSIS `Guild_0.5.35_x64-setup.exe`, Linux
  `Guild-0.5.35-x86_64.AppImage`, macOS DMGs + `.app.tar.gz` updater bundles
  (aarch64/x86_64). `/api/v1/updates/latest.json` serves 0.5.35 with all
  updater minisign signatures present — paired clients auto-update on their
  next 15-min check. Built from `agent-plane` (TS-server era: routines
  dropped — `RoutineStore` removed, registry install rejects automation
  bundles and the install response drops the `routines` field; M8
  integrations runtime; read-dot seq fix). Operator note: release publishing
  needs an admin session — a temporary one was minted directly in the dev
  DB for the run and revoked immediately after.

- **Read-dot fix: unread orders by seq, not event id (2026-10-04).** User
  report: read/unread not persisting on the TS branch. Diagnosis: read
  markers WERE persisted (route + rows verified live); the bug was the
  unread projection comparing `thread_events.id` — the turn-command
  idempotency contract makes the client's random uuid-v4 message id double
  as the user_message event id, and v4 sorts above every uuid-v7 harness
  event, so each chat pinned ~1 unread forever and the dot never cleared
  (Rust-era events were all v4, so id order was ill-defined there too —
  seq, the BIGSERIAL write order, was always the correct key, and mark-read
  already used it). Fix: the sidebar list and hub-feed unread projections
  now compare `e.seq > (marker event's seq)`; regression test covers a chat
  mixing v4 + v7 ids (read clears, new turn re-marks). 265/265 tests,
  redeployed, live-verified mark-all → 0 unread. Commit `fix` in
  `agent-plane` (see git log for hash).

- **Rust tree deletion prepared — `crates/server` fully decoupled (2026-10-04).**
  Two lanes. **TS side (direct, commit `f62a520`)**: exec-policy base rules
  relocated to `apps/server/assets/exec_policy_base.rules` (matcher default,
  Dockerfile build+runtime copies, tests updated) — the TS server no longer
  reads anything from the Rust tree at build or runtime. **Rust side (lane
  R9, `prep/rust-removal`, commits `0891b73`/`dc0df6e`/`06e5b14`)**:
  engine (`app-server`) and desktop tests that used `guild_server`
  test-support/build_router rewritten against hand-rolled mock routers
  (engine-side coverage preserved; Rust-server-internal coverage superseded
  by TS hub tests), `guild-server` dev-deps removed from both crates,
  `crates/server` dropped from the workspace member lists. Verified:
  `cargo check --workspace --all-targets` PASS, `cargo test -p app-server`
  PASS (80 lib + integration suites), protocol bindings generate and are
  fresh, dev stack rebuilt — exec policy loads from the new location
  (0 boot errors). **`crates/server/` remains on disk untouched**: deleting
  it is now a pure `git rm` gated on prod cutover + soak (rollback-image
  rebuild and the routines parity reference are the two remaining reasons
  to keep it until then). Report: `apps/server/R9-REPORT.md`.

- **M8: integrations chat runtime ported — the missing-tools regression fixed (2026-10-04).**
  The chat-loop integrations runtime was deferred (old decision 8) while the
  user's patent workflow runs on gmail/jira tools through chats, so after the
  M7 flip every turn answered `Tool google_workspace_gmail_search is not
  available`. Lane M8 (`feat/integrations-runtime`, commit `d233e8f`) ported
  the runtime from Rust (`crates/server/src/integrations/*.rs` ~3.4k lines +
  `restate.rs` chat flow): per-turn `{slug}_list_tools`/`{slug}_guide`
  registration with on-demand tool discovery and the system-prompt index,
  execute for all 7 built-in connectors (google_workspace incl. RS256 JWT
  service-account impersonation, atlassian, github, gitlab, slack, hubspot,
  langfuse, firecrawl, searxng), MCP `tools/call`, `always_ask` curation
  riding the approval-card gate, acting-as identity, `integration.tool_called`
  audit events, and the script API switched from the stub to real dispatch.
  pi-durable stays pinned 1.0.1. Verified: 264/264 tests (236 baseline + 28
  new, mock-server based — no external API calls in tests), typecheck clean,
  dev stack redeployed, LIVE check: `atlassian_jira_search` through the
  script API returned a real Jira issue (`ok:true`) with the audit event
  journaled; google_workspace left for the user to exercise with their own
  workspace identity. Spec decision 8 revised by this entry (dated
  amendment: integrations runtime in scope). Report:
  `apps/server/M8-REPORT.md`.

- **TS server architecture refactor: layers + narrow contexts (2026-10-04).**
  Two subagent lanes on `agent-plane` (prompt files + report verdicts, per
  the orchestration loop), dispatched on user instruction, fully autonomous:
  **R1 DAL separation** (`refactor/dal-layers`, commit `f559ef1`) — domain
  errors moved to neutral `platform/errors.ts` (wire shapes byte-identical),
  shared protocol code to `platform/domain/thread-events.ts`,
  `identity`→`EventStore` store-to-store import replaced by an injected
  `EmitOrgEvent` capability, raw route-level `BEGIN` transactions in
  `admin.ts`/`agents.ts` hoisted into store methods, and a new
  `src/test/arch-layers.test.ts` enforcing the import graph (stores must not
  import hub/harness/machines/chats/http/fastify; services must not import
  fastify). **R2 context decomposition** (`refactor/contexts`, commit
  `e72db91`) — `PlatformContext` demoted to composition root; route groups
  now receive narrow slices from `platform/contexts.ts` (Infra, IdentityCtx,
  ChatsCtx, GatewayCtx), cross-group stores passed explicitly; the
  `(app as any).platform` test-seam cast replaced by Fastify
  `app.decorate("platform")`; arch test also bans `PlatformContext` imports
  in `platform/http/*` outside `register.ts`. Both lanes verified
  independently after merge: typecheck clean, **236/236 tests** (was 230,
  +6 arch rules), suite run 3× green (one non-reproducing hub-test flake
  during lane R2 did not recur), dev stack rebuilt from the merged tree
  (`guild-server-ts:latest`), live smoke green: login + chats list + CORS
  preflight 204, 0 error lines in server logs. Lane reports:
  `apps/server/R1-REFACTOR-REPORT.md`, `apps/server/R2-REFACTOR-REPORT.md`.
  Layer rule now: http → services (harness/chats/hub/machines) → DAL
  (platform/store) → infra (db/crypto/time/s3/clickhouse).

- **M7 dev retirement complete — the ladder is DONE on the dev stack
  (2026-10-04).** The compose stack is TS-only (`compose-server-1`, image
  `guild-server-ts`); the Rust `server-rust` service and the
  proxy-everything layer are removed (routines/hooks/internal answer the
  clean 404 envelope — deferred per decision 8). Final verification:
  227 tests green (22 suites), headless client login + a real
  GLM-5.3-Flash turn through the all-TS stack (M7-SMOKE-OK), and the real
  shipped desktop daemon (WORKSTATION 0.5.33) linked through the TS hub with
  zero errors. Post-retirement trap fixed the same day: the Rust CORS
  layer (tauri-webview origin allow-list) had been riding the proxy —
  browser preflights (`/api/v1/ws/ticket`, `/faro/collect`) 404'd once it
  went away and the desktop web UI retry-looped; the layer is now ported
  natively (`src/http/cors.ts`, 230 tests incl. the CORS suite) with
  live-verified 204/ACAO behavior. The importer's re-runnability was
  additionally verified LIVE (2026-10-04, post-cutover): a second full run
  against the dev DB rebuilt 90 chats → 90 conversations, 3446 events →
  3446 entries exactly, documents preserved, turns healthy after
  (RERUN-SMOKE-OK); pre-rerun backup:
  `/tmp/guild-backup/guild-pre-rerun-0552.sql`. Prod ladder (`~/guild-live`, :18081)
  is the remaining step — held until maintainer validates dev (the plan
  gates prod on "after dev stabilizes"). Backup of the dev DB taken
  before the importer's final run:
  `/tmp/guild-backup/guild-2026-10-04-0332.sql`.
- **M1 platform core + M4 workspace sessions landed (2026-10-04).** M1:
  native auth (opaque sessions/argon2id/OIDC), org, events, attachments
  with 64 golden Rust fixtures replaying byte-semantically. M4: workspace
  agent sessions rooted at `workspaces/<org>/<name>` under `GUILD_DATA_DIR`,
  the exec-policy matcher at asset parity (32 rules), durable approval
  gates (block/resume), machine-tool dispatch over the hub (fake-daemon
  round-trip + real-daemon link verified), tool-artifact spill. Verified
  live: an agent-session turn wrote a file into the workspace sandbox and
  read it back; the policy correctly blocked shell tools with
  `GUILD_ALLOW_SHELL_TOOLS` unset (Rust parity). Reports:
  `apps/server/M1-REPORT.md`, `apps/server/M4-REPORT.md`.
- **M7 retirement landed (2026-10-04).** `apps/server` ported the last
  proxied surfaces on `m7/retire`: integration tool API (list, tools
  listing, execute with the Rust error/audit shapes; built-in connector
  tool manifests + test_connection; a minimal MCP streamable-HTTP client
  for plugin integrations — connect timeout 10s, MCP tool curation
  absent=disabled), the admin integration save path (create 409-on-dup /
  stub-create, update with secret merge + missing_secrets 409,
  test-then-persist; MCP config validation + live tools listing), and
  `GET/PUT /api/v1/me/approval` (desktop-client user approval policy, serde-
  exact validation texts). Secrets stay AES-256-GCM hex(nonce‖ct+tag) —
  all 9 live `integration_secrets` rows decrypt with the TS implementation.
  The proxy is gone: `GUILD_UPSTREAM_URL`, `@fastify/http-proxy` and the
  `server-rust` compose service removed; deferred routes (routines, hooks,
  internal — spec decision 8) answer the Rust 404 envelope; compose now
  runs the TS server only (with the `guild_data` volume for
  `$GUILD_DATA_DIR` workspaces). Full evidence + unported-route list +
  cutover runbook in `apps/server/M7-REPORT.md`. 227 tests green (22
  suites) on disposable `guild_m7_test_*` databases.

- **M6 long tail landed (2026-10-04).** The remaining M6 surfaces run
  natively in `apps/server` on `m6/longtail`: registry (S3-backed publish/
  review/install with the Rust bundle caps and manifest-validation error
  strings), releases (admin upload + ed25519 signing, signed download
  URLs, semver-exact updater `latest.json`), projects (the 0.5.34
  one-live-project-per-(machine,folder) rule with `folder_taken` 409,
  archive-frees-folder, chat machine-binding unlink), teams, admin users
  (last-admin guard + credential revocation on reset), org prompts
  (org_kv), admin integration reads + per-tool curation (row-lock RMW),
  faro ingest (exact-byte forward), and the chat-SPA serving (dist now
  built inside `Dockerfile.server-ts` stage `webui`, served from disk;
  golden byte check against the live stack is byte- and header-identical,
  `apps/server/scripts/m6-web-golden.ts`). Deferred still proxied with
  reasons in `apps/server/M6-REPORT.md` §3: routines CRUD/internal API
  (spec decision 8), the integration save path + tools listing and the
  script-side `/api/v1/integrations/*` (need the connector ports + MCP
  client; unreachable at M7). 160/160 tests green (sequential file mode —
  parallel lanes exhaust Postgres max_connections on the shared host DB).
- **M5 hub core landed (2026-10-04).** The `InMemoryHub` seam became the
  real `LiveHub` (`apps/server/src/hub/`): member/machine registries, 32
  socket caps, the 0.5.25 live-slot rule (a live machine slot is held —
  foreign-instance connects are rejected 409, same-instance reconnects
  displace only their own zombie), displacement on re-pair, and
  `machine_request`/`machine_request_pinned` with exact
  `MachineRequestError` semantics. `GET /api/v1/ws` flipped native
  (single 'upgrade' listener; proxy `websocket:true` removed — rollback
  restores the flag + deletes `attachWsUpgrade`) with `POST
  /api/v1/ws/ticket` (`gst_`, 30s TTL, single-use), member + machine
  socket loops (heartbeat 5s/10s, session watch → AuthRequired, sink
  high-water 4096, 30s last_seen throttle), and `GET /api/v1/machines` +
  `POST /api/v1/machines/{id}/fs` over the durable machine registry
  (fingerprint adoption re-pair re-keying incl. `projects`/`chats`
  machine_id moves). Golden WS frames captured from a locally built Rust
  0.5.34 (disposable synthetic DB, not the live stack) and replayed
  byte-compared; 113/113 tests green; report in
  `apps/server/M5-REPORT.md`. Remaining for later lanes: feed forwarder,
  sync frames, tool-result completion, `reconcile_machine_tools` (all
  behind `ctx` seams).
- **M3 harness + chats cutover landed (2026-10-04).** `apps/server` now runs
  the durable agent engine itself: pi-durable 1.0.1 over the M3 Postgres
  storage (one owning process, `GUILD_SANDBOX_ROOT` exec env), model access
  as an OpenAI-compatible client looped back through the server's own
  gateway (`GUILD_SELF_BASE_URL`, internal key + `x-guild-org-id`, so
  harness turns are metered exactly like external calls; the gateway honors
  `stream_options.include_usage` — additive, default streams stay
  byte-identical). Chat CRUD / thread read+append / turn submission
  (`POST /api/v1/gateway/chat`) / stop / approval / compact / mark-read
  routes are native with serde-rejection + wire parity; `chat_conversations`
  maps each chat 1:1 to an ownerless durable conversation; the bridge
  persists run output as `thread_events` (ThreadState-byte-compatible rows)
  and settles `turn_commands`. New additive SSE surface
  `GET /api/v1/chats/{id}/thread/stream` pushes byte-exact ThreadState
  frames (verified against live Rust member-socket captures); the member WS
  itself stays proxied until M5. The re-runnable thread importer
  (`npm run import-threads`, `apps/server/src/importer/`) truncates +
  rebuilds `durable_*` + the mapping from `thread_events` — tested against
  real anonymized captures (314 events / 4 chats incl. approvals, tool
  loops, a compaction, an empty chat), idempotent rerun verified, CLI
  smoke-run done. Restate is removed from the compose stack
  (`server-rust` runs `GUILD_ROLE=api`). Machines routes stay proxied and
  `machine_online` stays false until M5 (documented deviations).
  95/95 tests green on disposable `guild_m3_test_*` databases; report in
  `apps/server/M3-REPORT.md`.

- **M2 LLM gateway landed (2026-10-04).** `apps/server` serves the OpenAI
  and Anthropic completion surfaces natively (`/openai/v1/*`,
  `/anthropic/v1/*`) with byte-compatible SSE (verified against 12
  live-capture golden fixtures, both streaming dialects), org API keys
  (`gk_*`, sha256-at-rest, auth_generation stamping), month-to-date quota
  enforcement via ClickHouse `usage_events`, usage/series/summary
  endpoints, gateway admin providers/routes CRUD, and the env-minted
  `GUILD_INTERNAL_KEY` loopback key (org scoping via `x-guild-org-id`,
  synthetic internal uuids for usage attribution — no schema change).
  `/api/v1/gateway/chat*` stays proxied until the M3 chats cutover.
  81/81 tests green on disposable `guild_m2_test_*` databases; report in
  `apps/server/M2-REPORT.md`.

- **M3 storage core landed early (2026-10-04).** The pi-durable Postgres
  storage backend (`apps/server/src/storage/postgres/`: durable_\* tables
  per design decision 5, portable core + pg adapter) passes pi-durable's
  full conformance suite (23/23), reopen-across-restart tests, and
  benchmarks. pi-durable 1.0.1 gaps found so far are recorded as a dated
  spec amendment. The rest of M3 (harness wiring, chats routes + SSE,
  importer, restate removal) follows M2's internal gateway key.
- **M0 — TS server shell cutover landed (2026-10-04).** `apps/server`
  (Fastify) serves `/api/v1/health` natively and proxy-everything (HTTP + WS
  upgrade) to the Rust server on the compose network; TS container
  (`guild-server-ts`, tsc at build time) owns the public port :18080, Rust
  service renamed `server-rust` (internal only). Verified on the dev stack:
  login + a real GLM-5.3-Flash turn end-to-end through the proxy via the
  headless client, and real desktop daemons (WORKSTATION 0.5.33, devbox 0.5.25)
  reconnected and working through it. Trap found: renaming the Rust service
  must move `GUILD_WORKER_ADVERTISED_URL` to `http://server-rust:9080` or
  restate's deployment discovery 500-loops and every ChatRunner turn hangs;
  the stale `http://server:9080/` deployment had to be force-deleted from
  restate. Spec amendment recorded: sessions are opaque tokens in the
  `sessions` table, not JWTs. Design:
  `docs/specs/2026-10-04-ts-server-pi-durable-design.md`; milestones:
  `docs/plans/2026-10-04-ts-server-pi-durable-plan.md`. Work branch:
  `agent-plane` (worktree `~/guild-wt-agent-plane`).
- **TS server rebuild on pi-durable starts (2026-10-04).** The cloud server
  is rebuilt in TypeScript on `@earendil-works/pi-durable` (pinned `1.0.1`,
  never forked, no upstream fix loop); Restate is dropped; the public API,
  platform schema (existing Postgres tables verbatim), and concepts stay the
  same. Staged cutover with the TS server in front proxying un-ported routes
  to the Rust server; Rust retires at parity. Thread history imports into
  durable storage via a re-runnable importer; model access always goes
  through the gateway over loopback. Routines are deferred (unused today).
  Design: `docs/specs/2026-10-04-ts-server-pi-durable-design.md`; milestones:
  `docs/plans/2026-10-04-ts-server-pi-durable-plan.md`. Work branch:
  `agent-plane` (worktree `~/guild-wt-agent-plane`).
- **Prod is a separate checkout** (`~/guild-live`, branch master, compose
  stack on :18081, public at guild.example.org). Deploy to prod by
  fast-forwarding its master from ~/guild's develop (fetch the local path,
  merge --ff-only — its docker-compose.yml carries prod-local edits, so
  never rebase it) and `docker compose build server && up -d` there. First
  multi-workspace deploy: 0.5.32 on 2026-09-30. The 0.5.22→0.5.32 jump
  exposed that an untracked migration file breaks the tree — migrations
  must be committed with their store/mod.rs entries.

- **Multi-workspace auth — the daemon holds N live sessions, one per
  server.** The desktop client can now be signed into two guild servers
  (different domains) at once and switch between them: both servers see the
  machine online and either can dispatch tools. Design spec:
  `docs/plans/2026-09-30-multi-workspace-auth-design.md` (approved:
  "both live simultaneously", not Slack-style single-active switching).
  Mechanics: `workspaces.json` (session list + active pointer) beside
  `token.json`, which stays the ACTIVE session's mirror so the watcher,
  CLI logins, and every reader keep working. The single machine-link
  channel became a registry (one link task per live workspace, supervisor
  per host cycle). New RPC: `workspace.list`, `workspace.switch`;
  `session.clear` gained an optional `base_url` (per-workspace sign-out).
  Webview: workspace switcher in the account menu, "Add workspace" shows
  the pair/sign-in card over the running app; switching re-mirrors
  `session.info` and reloads (the existing restore path). Accepted
  consequence: one machine's executor serves two servers concurrently —
  dispatches are independent requests, the executor processes them one at
  a time. Machine slots are per-server, so the 0.5.25 live-slot rule is
  unaffected. A dead token in one workspace keeps its row listed as "sign
  in again" instead of vanishing.

- **0.5.25 — a live machine slot is held, not displaced.** Root cause of the
  recurring devbox outages: any locally-run guild binary (dev sessions on
  this box — which IS devbox) loads the real token.json and connects a
  machine link as the same row; the hub's newest-wins displacement handed
  the slot to the thief, and the displaced link never learns it lost the
  slot — its leftover server conn keeps heartbeating, so the daemon sits
  "connected" while the machine shows offline until the daemon restarts.
  The hub now REJECTS a connect from a different instance while a live slot
  exists (same-instance reconnects still replace their own zombie slot —
  that's the blip-heal path); clients of every deployed version already
  park 300s on the Displaced notice and retry. Rejections are logged with
  machine + instance. Known limit: instance_id is client-claimed, so a
  determined spoofer could still bypass — real defense would need
  per-instance credentials. Server-only change; no client release needed.

- **0.5.24 — the Windows machines were offline because of one misplaced
  flag.** WORKSTATION's daemon trace (the 0.5.23 toggle earning its keep) showed
  `daemon host cycle failed: os error 87` once per second: the Sep 23 pipe
  rewrite passed `PIPE_REJECT_REMOTE_CLIENTS` in `dwOpenMode` where the bit
  is unassigned, so `CreateNamedPipeW` failed on every call and the host
  cycle aborted + respawned the machine link once a second — no Windows
  client could hold a link past ~1s (WORKSTATION, DEVBOX-2), while the
  Linux daemon path never runs this code. Flag moved to `dwPipeMode`; the
  reclaiming host also no longer tears the link down on a failed bind (the
  link is independent of the CLI socket — the Sep 23 abort+respawn shape
  was the storm's other half). Lesson that keeps paying: the Sep 25
  instrumentation + the 0.5.23 trace toggle turned "why is it offline"
  into a one-line answer without touching the user's machine.

- **0.5.23 — daemon trace behind a settings toggle (WORKSTATION offline hunt).**
  WORKSTATION's machine link connects and the client closes it ~3 ms later
  (server telemetry: `reader_closed`, zero frames), then no retry for
  minutes — the retired-socket-host path, not the 1 s backoff. Same
  signature as DEVBOX-2's flap; Linux daemon links live. The client
  trace that names the end reason was env-gated only, which is useless on
  a user machine. dtrace now has a runtime gate (`dtrace::set_enabled`),
  the desktop app persists the choice (`daemon-trace.enabled` marker in the
  guild config dir, seeded at launch) and exposes it in Settings → About
  with the trace file path shown. The env var still works for headless
  daemons. Trace file now size-capped (1 MiB, same as the IPC trace).

## Where things stand

- **Server** runs on :18080 (compose, embedded web bundles). It carries the
  0.5.19 feature set plus six full review rounds merged on 2026-09-24
  (126 findings fixed across auth/session, machines/executor identity, turn
  queue, provider contracts, engine session lifecycle, integrations, and
  desktop transport). Live-bundle and migration state verified per deploy.
- **Clients:** desktop 0.5.22 released 2026-09-26 (all four platforms,
- **Telemetry (opt-in):** the server proxies `POST /faro/collect` to the
  shared Faro collector (Alloy+Loki in `/srv/faro`, `GUILD_FARO_URL`); the
  client ships a Settings → About toggle (off by default, localStorage
  `guild.faro.enabled`) that lazy-loads `@grafana/faro-web-sdk` and sends
  app diagnostics through the paired server. Collector receives app_name
  `guild`; logs land in Loki (`/srv/faro`), traces forward to Laminar.
  installers + updater bundles, sha256-verified, updater manifest serving it
  with minisign signatures). 0.5.22 ships the mobile-chat fixes: the
  project-chat send crash (uncaught render error bricked the view — analysis
  and repro in docs/plans/2026-09-24-mobile-chat-ux.md), chat error boundary,
  icon-only composer badges on narrow screens, touch-drag containment
  (pull-to-refresh no longer pans the shell), top-center toasts on phones.
  0.5.21 (2026-09-25) shipped the CSP removal — avatars render in desktop
  and web clients. Running clients pick releases up via the auto-updater on
  relaunch; the devbox install (0.5.18) must be relaunched (or updated in
  place) to reconnect — 0.5.18 cannot talk to the current server. Client
  releases remain dev-controlled and deliberate.
- **Quality baseline:** six review rounds with adversarial verification; the
  last two fix-diff audits found no regressions. Full gates at merge time:
  workspace cargo test (705+ tests), frontend vitest, strict clippy,
  windows-gnu check (`scripts/check-windows.sh`), bindings freshness.

## Next steps (ordered)

1. **Ship desktop 0.5.20 to the devbox install — blocking, user-visible.**
   The release is published and verified; the devbox install (0.5.18) needs a
   relaunch so its auto-updater takes 0.5.20, then confirm the machine link
   establishes against the current server.
2. **Confirm-or-reopen two legacy items** (their original context predates
   the review loop):
   - Thread list + thread messages keyset pagination/infinite scroll —
     `list_events_page` may already exist in a prior working tree; check and
     finish or re-plan.
   - Machine-link flap diagnosis (0.5.17-era) — later rounds reworked the
     watchdog/error-frame handling; likely improved but never confirmed
     against a flapping client. Re-open only if a client still flaps.
3. **Fix the flaky reaper test** `the_reclaiming_daemon_entry_reaps_completed_agent_tasks`
   (fixed 12 s sleep racing a 10 s cadence; failed under load three times
   during verification).
4. **Optional client hardening after the 0.5.20 rollout:** confirm the updater
   pending-update fix behaves on a real install (it was logic-verified only —
   Tauri updater APIs need an app bundle to test).

## Future directions

- **A future review loop** (when a meaningful diff accumulates): start from a
  surface-coverage map rather than a full-diff audit — see
  `docs/reviews/2026-09-24-loop-summary.md` for the per-surface pass counts
  and the process playbook (mixed reviewers; pi fixer/verifier; verifier
  rebuilds exploit chains against the real caller; env var gotcha:
  `GUILD_TEST_PG_URL` is a base URL without a db suffix).
- **Review coverage gaps to close in that loop:** Windows-only engine paths
  (compile-checked, never executed), desktop updater flows (logic-verified
  only), integrations connectors (one sweep), and the accepted residuals
  listed in the round FIX/VERIFY reports (per-frame usage billing,
  process-crash usage loss, html_csp parser latent note).
- **Engine/product direction unchanged:** one agent loop, thin desktop
  backend, project-derived executor binding, durable Restate workflows. The
  review rounds tightened contracts (auth generations, executor identity
  validation, effect-claim tombstones) without changing the architecture.

## Working conventions

- **Always redeploy after a change** — detached compose build+up from
  `deploy/compose`, then verify the live bundle hash and API health. The
  user tests against :18080.
- **Sessions run this repo concurrently** — check `git log`/`git status`
  before and after editing; pull rather than clobber.
- **Review-loop branch topology:** `review/roundN-<agent>`, `fix/roundN`,
  `verify/roundN` worktrees under `~/guild-wt/`, merged `--no-ff`, branches
  and worktrees retired after merge; orchestrator prompt/report files stay
  out of the repo root (reports live under `docs/reviews/`).
- Comments describe what code IS and does now — no history narration. Docs
  like this file carry the story.
