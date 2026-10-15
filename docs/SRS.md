# Guild — Software Requirements Specification (SRS)

The system-level contracts that satisfy `docs/PRD.md`. Every claim is
verified against the code (paths in each section). Present-tense
requirements only; identifiers are stable (`SRS-n`) for citation.

Group index:

| Group | Covers | SRS ids |
|---|---|---|
| 1 | Architecture invariants | SRS-1 … SRS-5 |
| 2 | Executor taxonomy | SRS-6 … SRS-9 |
| 3 | Binding model | SRS-10 … SRS-13 |
| 4 | Thin desktop backend contract | SRS-14 … SRS-18 |
| 5 | Machine registry + WS transport | SRS-19 … SRS-25 |
| 6 | Data model | SRS-26 … SRS-29 |
| 7 | WS protocol | SRS-30 … SRS-32 |
| 8 | HTTP API surface | SRS-33 |
| 9 | Daemon JSON-RPC verbs | SRS-34 |
| 10 | Tool artifacts | SRS-35 … SRS-38 |
| 11 | Skills / context assembly | SRS-39 … SRS-42 |
| 12 | Integrations | SRS-43 … SRS-47 |
| 13 | Security invariants | SRS-48 … SRS-51 |
| 14 | Error handling + testing | SRS-52 … SRS-55 |

---

## 1. Architecture invariants

**SRS-1 — One agent loop.**
Exactly one agent loop exists: the durable gateway workflow
(`crates/server/src/worker/restate.rs`, the `ChatRunner` Restate object,
driven through `worker/funnel.rs`). Tool looping, model-turn sequencing,
exec policy, approval gating, history persistence, compaction, and quota
enforcement all live in that workflow and nowhere else.

**SRS-2 — Frontends carry no agent semantics.**
A frontend (desktop webview, browser tab, engine stdio client) sends
messages, renders `thread_state`, answers approvals, and assembles client
context; it never sequences tool calls or builds model turns.

**SRS-3 — Rust never talks to the model.**
Only the server's gateway layer holds provider credentials and issues model
requests. The desktop backend, CLI, and engine code contain no provider
client path.

**SRS-4 — Parity by construction.**
A frontend differs from another only in which executors are attached. A
feature lands once in the TS frontend plus once in the server, and desktop
and web both get it.

**SRS-5 — Executors are a dispatch shape, not architectures.**
Adding an executor is a new arm in `worker/funnel.rs::Executor` and a
dispatch-shape change; it never forks the loop. All arms share the same
exec-policy and approval gates (the sandbox arm runs them before dispatch;
the desktop arm runs them before suspension).

## 2. Executor taxonomy

**SRS-6 — Three executors.**
The funnel's executor type has exactly three variants
(`worker/funnel.rs::Executor`): `Desktop`, `Sandbox`, `ServerLocal`. Each
tool call resolves to one executor at turn time.

**SRS-7 — Desktop executor.**
`Desktop { machine_id, machine_label, workdir }` dispatches over the
machine's singleton WebSocket to the desktop backend, which executes through
its `ToolRegistry` (`read_file`, `write_file`, `edit_file`, `execute`) and
returns the result over the same socket. A desktop executor is reachable
ONLY through a project binding: the workdir is the bound project's folder.

- Dispatch is journaled once (KV claim keyed by the awakeable id); a replay
  never re-sends the frame to a new connection.
- Machine liveness is watched while suspended: socket loss beyond a grace
  window resolves the call as an error; a connection change resolves as
  "outcome unknown" (side-effecting tools are never blindly re-run).
- A durable 5-minute timeout backstops every suspended call; late and
  duplicate completions no-op through the durable `complete_tool` handler.

**SRS-8 — Sandbox executor.**
`Sandbox` runs the same client-tool specs server-side against a per-chat
directory `data_dir/sandbox/{chat_id}`. Every unbound chat (web or desktop
origin) uses it. The static exec-policy gate and the interactive approval
gate both run before execution; `execute` additionally requires the server
shell flag (`allow_shell_tools`).

**SRS-9 — Server-local executor.**
`ServerLocal { dir }` is the batch workspace backend: the workflow executes
the tool in-process against an org workspace directory under
`workspaces/{org}/{name}` (never a client path). Its contract is
pre-approved: no interactive approval gate, but the static exec-policy gate
still applies to `execute`, and shell tools require the server flag. History
is the thread journal; the HTTP surface is submit + poll
(`/api/v1/agents/sessions`).

## 3. Binding model

**SRS-10 — Machine binding is project-derived.**
A chat's executor machine derives only from its bound project: the project
names the machine and the folder; the folder is the workdir. There is no
machine-bound-without-project state.

**SRS-11 — No direct chat→machine binding paths.**
No create-time `machine_id` on chat create, no per-chat machine
bind/unbind endpoint, and no desktop-origin auto-bind exist. The sandbox
fallback condition is "no project bound" — never "no machine and no origin".

**SRS-12 — `origin_machine_id` is audit metadata.**
The originating desktop's machine id may ride the completion request and
the journal as provenance ("sent from machine X") with no binding behavior:
it never selects an executor and never persists onto the chat.

**SRS-13 — Unlink clears the binding.**
Setting a chat's project to null (or deleting the project) clears the chat's
machine binding and label; the chat becomes fully unbound and sandbox-
executed.

## 4. Thin desktop backend contract

One Rust process per desktop (`crates/app-server`, launched by the Tauri
app; the detach-and-survive lifecycle retained). Its complete surface:

**SRS-14 — Machine executor.**
The backend owns the machine link (`machine_link.rs`): one WebSocket to the
server, `ToolDispatch` receive, `ToolRegistry` execution, `ToolResult`
return, identity persistence in `token.json`, registry metadata reporting
(fingerprint, OS, app version). The link survives GUI closure and app
restarts.

**SRS-15 — File bridge with an explicit allowlist.**
The `fs.*` verbs (`fs_bridge.rs`) are the only filesystem surface the
webview can reach. The allowlist is the security boundary — never "anything
under $HOME":

- Read roots: the Guild config dir, the user's `~/.agents`, the bound
  project folder, and its ancestor chain up to and including the git root.
- Write roots: the config dir and the project folder.
- Existence probes additionally walk ancestors for `.git` only (git-root
  discovery); reads never go above the read roots.
- Paths normalize through symlinks component-wise, so link-based escapes
  land on their real target and fail the root check; `..` is popped
  lexically. Relative request paths anchor at the project.

**SRS-16 — Registry crypto.**
The backend performs bundle hashing (sha256 over bundle bytes) and the
provenance sidecar writes for publish/install/uninstall; release artifacts
are ed25519-signed over their sha256 digest (`crates/server/src/signing.rs`)
and the public key is served for verification. Guild metadata lives in
manifests and sidecars, never inside SKILL.md.

**SRS-17 — Auth store.**
`auth_state.rs` owns token.json + machine identity + link publication: one
`transition` method per mutation (login, pair, identify, sign-out) applies
mutate ⇒ persist ⇒ publish; the RPC verbs are thin over it. The webview
holds its own session token for direct HTTP; the backend uses its stored
credentials for the machine socket.

**SRS-18 — Engine entry points ride the gateway.**
`agent.start` and `chat.send` drive the durable gateway workflow
(`agent_start.rs::drive` / `drive_chat`) and map its `StreamEvent`s onto the
engine protocol's `agent.*` events; approvals ride the approvals HTTP
endpoint through the journal. No second completion loop exists.

## 5. Machine registry + WS transport

**SRS-19 — Durable machine registry.**
The `machines` table is one row per pairing: `machine_id` (PK,
server-issued at pairing), `org_id`, `user_id`, `label`, 
`hardware_fingerprint`, `os`, `os_version`, `app_version`, `last_ip`, 
`first_connected_at`, `last_connected_at`, `last_seen_at`, `re_paired_at`
(`crates/server/migrations/0046_machines.sql`). Writes happen on connect and
pairing adoption; `last_seen_at` refreshes on a 30 s throttle off socket
pings; disconnect writes nothing (absence of the socket is the disconnect).

**SRS-20 — Singleton machine socket with displacement.**
Exactly one socket per `machine_id`; a second connect evicts the first
(newest wins). The displaced holder receives a `displaced` notice and a
clean close; a stale instance's resume reconnect is answered `displaced`
and is terminal — only a fresh (non-resume) connect takes the slot.

**SRS-21 — Ticket auth.**
Both browsers and machines connect to `/api/v1/ws` with a single-use,
30-second-TTL ticket minted over authenticated HTTP
(`POST /api/v1/ws/ticket`); raw tokens never appear in the upgrade query
string. Ticket state is in-memory (a restart invalidates tickets; clients
mint a fresh one per connect). Session expiry mid-connection sends
`auth_required` and closes.

**SRS-22 — Sanity cap.**
At most 32 sockets per user (`hub.rs::MAX_SOCKETS_PER_USER`); over-limit
upgrades are rejected with an explicit error.

**SRS-23 — Liveness is the socket.**
Server→client protocol ping every 5 s with a unique challenge payload; only
the byte-matching pong counts; an unmatched challenge expires after 10 s and
closes the socket. Every server write has a 1 s deadline; outbound backlog
over 4096 frames latches overload and interrupts the writer. Desktop side:
20 s read-silence deadline, 20 s bootstrap deadline, outbound queue 1024
with a 16-slot priority lane for pong/close. There is no HTTP heartbeat
endpoint.

**SRS-24 — State sync on every connect.**
A (re)connect is a stateless client: server pushes `thread_list`, the client
declares its open chat with `sync`, and the server answers
`sync_begin → thread_state → sync_done`, where `thread_state` is the atomic
authoritative view (durable events + in-flight buffers + project fields)
under a `seq` watermark. Clients apply a `thread_state` only when its
watermark is strictly newer than the last applied view.

**SRS-25 — Log-then-broadcast.**
A command (send, approval, project change) is written to the durable log
first; the commit fires `pg_notify('guild_thread_committed')`, and the feed
re-captures and broadcasts the committed `thread_state` to every socket of
the user, including the sender's. The DB thread log is the source of truth;
the socket is fan-out only.

## 6. Data model

**SRS-26 — Postgres holds the records.**
Live tables (verify against `crates/server/src/store/` + 
`crates/server/migrations/`): `orgs`, `users`, `teams`, `team_members`, 
`sessions` (opaque tokens, sha256-hashed), `oidc_configs`, `pairing_tokens`, 
`provider_keys` (encrypted secrets), `model_routes`, `chats` (incl. 
`machine_id`/`machine_label` columns derived from the project, `project_id`, 
`generating`, `approval`, archive flag), `thread_events` (the history log —
there is no separate messages table), `chat_reads`, `attachments`, 
`projects` (id, org_id, user_id, name — display label, duplicates allowed, 
folder, machine_id), `machines` (SRS-19), `registry_items` + 
`registry_versions` (with `reviewed_version` + `reviewed_bundle_sha256` 
binding approval to content), `integrations` + `integration_secrets` 
(AES-256-GCM, masked preview column), `api_keys`, `routines` + 
`routine_runs`, `events` (org audit log), `agent_sessions`, `releases`, 
`org_kv`/`server_kv` (incl. the `tool_dispatch:` claim keys), 
`tool_artifacts`. Schema changes go through embedded, checksummed
migrations applied under an advisory lock.

**SRS-27 — ClickHouse holds usage events.**
`usage_events` (ts, org_id, user_id, team_id, session_id, model, provider, 
tokens_in, tokens_out, cost_usd, request_id), inserted per model request;
failures to write never break chat. Dashboards and quota checks query it
directly; there are no roll-up tables.

**SRS-28 — Object storage holds the bytes.**
RustFS (S3-compatible) stores registry bundles
(`registry/{org}/{kind}/{slug}/{version}/{sha256}.tar.gz`), attachments and
tool artifacts (`object_key(org_id, id, filename)` per the store modules).
Clients never hold object-store credentials; downloads go through
member-authenticated HTTP endpoints.

**SRS-29 — Restate journals hold only the active subset.**
The durable journals of in-flight runs (current step, pending awakeables,
timers) live in Restate; on completion, results persist to Postgres and the
journal retires. No long-term record lives only in Restate.

## 7. WS protocol

Per `crates/protocol/src/ws.rs` + `crates/server/src/http/{ws,hub,feed}.rs`.
JSON text frames, internally tagged by `type` (snake_case).

**SRS-30 — Frames.**

Client → server:

| Message | Fields | Purpose |
|---|---|---|
| `sync` | `chat_id: uuid\|null` | Declare the open chat; the server answers with the state-sync bracket. |
| `tool_result` | `chat_id, call_id, content, is_error, meta?` | Deliver a machine-tool outcome (funnels into the durable `complete_tool`; late duplicates no-op). |

Server → client:

| Message | Fields | Purpose |
|---|---|---|
| `hello` | — | Registration accepted. |
| `displaced` | — | This machine's singleton slot is taken (this connection lost it). |
| `auth_required` | — | Session expired/revoked; refresh over HTTP and reconnect. |
| `tool_dispatch` | `chat_id, call_id, name, arguments, workdir?` | A tool execution addressed to THIS machine connection; `workdir` is the project folder. Never replayed as display state. |
| `error` | `message` | Recoverable error notice (e.g. dropped frames → resync). |
| `thread_list` | `chats[]` | Full chat list (sidebar state); sent on connect and on change. |
| `chat_status` | `chat_id, generating` | Owner-scoped thread-list spinner frame. |
| `sync_begin` / `sync_done` | `chat_id` | State-sync bracket for one chat. |
| `thread_state` | `chat_id, seq, events[], text, thinking, generating, project_id?, project_name?, project_machine_label?` | The only rendered-content source; atomic authoritative view under a watermark. |
| `live_frame` | `chat_id, generation_id, seq, machine_id?, event` | Non-replayable generation stream for command consumers; view clients use `thread_state` exclusively. |
| `org_event` | `event` | Org-scoped event from the `guild_events` NOTIFY channel. |

**SRS-31 — Lifecycle.**
Connect: mint ticket → upgrade (query: `ticket`, `client_id`, and for
machines `machine_id` + `machine_name`) → register (singleton or member) → 
`hello` → `thread_list` → per-open-chat sync bracket → live frames.
Reconnect repeats the sequence from ticket minting; reconcile is
overwrite-under-watermark.

**SRS-32 — Dispatch and results.**
A suspended client tool dispatches to the bound machine's socket with the
project workdir; the desktop executes locally and replies `tool_result` over
the socket. On machine reconnect, pending dispatches reconcile against the
per-machine claim registry: a dispatch whose connection changed resolves as
"connection changed; outcome unknown" rather than re-executing.

## 8. HTTP API surface

**SRS-33 — Route families.**
All HTTP lives under `/api/v1` (plus the OpenAI-compatible
`/openai/v1/chat/completions`), per `crates/server/src/http/mod.rs::build_router`:

- Health: `GET /api/v1/health`.
- Auth/identity: `/api/v1/auth/{bootstrap,login,me,refresh,pair,oidc/*,pairing-tokens*}`, `GET /api/v1/me/approval`.
- Chats: `POST|GET /api/v1/chats`, `PATCH /api/v1/chats/{id}`, 
  `/api/v1/chats/{id}/thread` (GET history, POST client-appended events), 
  `/api/v1/chats/{id}/project`, `/api/v1/chats/{id}/approval`, 
  `/api/v1/chats/{id}/read`, `/api/v1/chats/{id}/attachments`, 
  `/api/v1/chats/{id}/tool_artifacts`, `GET /api/v1/machines`.
- Projects: `POST|GET /api/v1/projects`, `PUT|DELETE /api/v1/projects/{id}`.
- Gateway: `GET /api/v1/gateway/models`, `POST /api/v1/gateway/chat`, 
  `POST /api/v1/gateway/chat/{id}/{stop,compact}`, 
  `POST /api/v1/gateway/chat/{id}/approvals/{call_id}`.
- Workspace sessions (batch backend): `POST|GET /api/v1/agents/sessions`, 
  `GET /api/v1/agents/sessions/{id}`, 
  `POST /api/v1/agents/sessions/{id}/turns`.
- Attachments/artifacts: `GET|POST /api/v1/attachments*`, 
  `GET /api/v1/tool_artifacts/{id}`.
- Registry: `POST|GET /api/v1/registry/{kind}`, 
  `GET /api/v1/registry/{kind}/{slug}`, 
  `GET .../{version}/bundle`, `POST .../install`, `POST .../review`.
- Releases: `GET /api/v1/releases`, `/api/v1/releases/{id}/download*`, 
  `/api/v1/releases/signing-key`, `/api/v1/updates/latest.json`, admin upload/list under `/api/v1/admin/releases`.
- Integrations script API: `GET /api/v1/integrations`, 
  `GET /api/v1/integrations/{slug}/tools`, 
  `POST /api/v1/integrations/{slug}/tools/{tool}`.
- Routines: `POST|GET /api/v1/routines`, `PUT|DELETE /api/v1/routines/{id}`, 
  `GET /api/v1/routines/{id}/runs`, `POST /api/v1/hooks/{org_id}/{slug}`.
- Usage: `GET /api/v1/usage{,/summary,/series}`.
- Org events: `GET /api/v1/events`.
- Admin: `/api/v1/admin/{users,teams,api-keys,oidc,gateway/*,integrations*}` — 
  integrations include `GET|PUT .../{id}/tools[/{tool}]` (curation) and 
  `GET .../{id}/secrets` (masked), plus 
  `/api/v1/admin/{approval-policy-prompt,assistant-prompt}`.
- Internal (Restate worker callbacks): `/api/v1/internal/{routines/{id},runs,runs/finish,completion,storage}`.
- WebSocket: `POST /api/v1/ws/ticket`, `GET /api/v1/ws` (upgrade).

## 9. Daemon JSON-RPC verbs

**SRS-34 — Engine protocol verbs.**
Line-delimited JSON-RPC 2.0 with a `protocol` version field on every
envelope (`crates/protocol/src/rpc.rs`, PROTOCOL_VERSION = 1; BUILD_ID
handshake in `daemon.hello`). Dispatch table in
`crates/app-server/src/jsonrpc_loop.rs`:

- Auth/session: `login`, `pair`, `session.info`, `session.clear`, 
  `machine.identify`, `machine.info`, `models.list`.
- Chat/agent: `chat.send`, `agent.start`, `agent.approve`, 
  `agent.policy.set`, `agent.policy.get`.
- Registry: `registry.publish`, `registry.install`, `registry.uninstall`.
- File bridge: `fs.scopes`, `fs.read_text`, `fs.list_dir`, `fs.exists`, 
  `fs.write_text`.
- Lifecycle (CLI handshake): `daemon.hello`, `daemon.shutdown`.

Unknown methods return a standard RPC error. Server-push events ride the
same connection (`agent.text`, `agent.tool_call`, `agent.tool_result`, 
`agent.approval_request`, `agent.done`, `agent.error` — the mapping in
`agent_start.rs::map_frame`).

## 10. Tool artifacts

Per `crates/server/src/worker/spill.rs`, `crates/guild-core/src/tools/artifacts.rs`, 
`crates/app-server/src/artifacts.rs`.

**SRS-35 — Spill trigger and ceilings.**
One choke point where a server-side tool outcome becomes a
`ThreadEvent::ToolResult`: serialized content above 64 KiB spills into an
artifact; a tool-carried artifact payload spills regardless of size.
Per-tool caps are storage ceilings, not history protection (the generic
HTTP tool's 1 MiB ceiling spills instead of truncating). Local tools keep
inline caps and never spill.

**SRS-36 — Storage and event shape.**
A spilled result is a `tool_artifacts` row (id, org_id, chat_id, filename, 
content_type, size_bytes, object_key UNIQUE, tool_name, call_id) plus bytes
in object storage. The event carries `artifact_id: Option<Uuid>` (never the
storage key) and a meta card — `card: "artifact"` with `id`, `filename`, 
`content_type`, `size_bytes`, `path` (existing tool meta keys preserved) —
which drives the UI download card.

**SRS-37 — Model-facing pointer and path contract.**
The model-facing content is pointer text naming the workspace-relative path 
`.guild/artifacts/<chat_id>/<filename>`: text mimes add "First 2 KiB of N
KiB" with the head excerpt; binary mimes get path + size + mime only.
Filename collisions inside a chat take a deterministic id-prefix. The id is
uuid v5 over chat_id + call_id, the insert is `ON CONFLICT DO NOTHING`, and
the spill rides the journaled tool-execution run — a replay reuses the same
artifact and never re-uploads a duplicate.

**SRS-38 — Materialization.**
The desktop engine fetches artifact bytes from
`GET /api/v1/tool_artifacts/{id}` on first touch when the file is not
materialized (the path→id index rebuilds from the chat's thread log when
unknown) and prefetches in the background right after journaling while a
member socket is connected; materialized copies live indefinitely. A read
of an unmaterialized artifact fails with an explicit message rather than a
dead path. `.guild/artifacts/` sits inside the workspace scope, so the
ordinary tools reach it with no special policy.

## 11. Skills / context assembly

Per `apps/desktop/src/lib/context.ts` + `skill-mention.ts` (TS owns the
logic; Rust only touches bytes through `fs.*`), with the server as the
enforcement cap (`crates/server/src/worker/restate.rs`).

**SRS-39 — Bundle format and scopes.**
A skill is a SKILL.md directory; Guild metadata lives in the
`agents/guild.yaml` provenance sidecar (source, slug, version, org,
publisher, published_by_me, review_status, installed_at, bundle_hash).
Discovery scans, in order: the config-dir scope, the user `~/.agents`
scope, the repo `.agents/skills` chain from the git root to the working
dir, and the legacy `.guild` scopes. A later entry wins a name collision
(repo/user beats config/legacy). Disabled paths from
`{config_dir}/settings.json` (`skillsDisabled`) are excluded.

**SRS-40 — `/name` invocation.**
A `/` token at word start (text start or after whitespace; only lowercase
letters, digits, hyphens inside) opens the composer autocomplete; a picked
mention appends a context block (`### Skill: <name> (<path>)` + full
SKILL.md body) to the turn's prompt. Unknown tokens pass through.

**SRS-41 — Index budget.**
The rendered index (name — description per skill) is capped at 8,000 bytes:
description clipping first (120/60/24 chars tiers), then tail-dropping with
an "N skills omitted" notice. The server re-caps client-sent `skills_index`
at the same budget before rendering — the server stays the enforcement
point, and the client never sends a system prompt (both fields are
additive, server-framed segments).

**SRS-42 — AGENTS.md chain.**
The chain is the global config-dir file (`AGENTS.override.md` beats
`AGENTS.md`) plus one file per directory from the git root down to the
working dir (override beats plain; empty file stops that directory's
contribution), joined under a shared 32 KiB budget with byte-truncation;
the server caps it again (`AGENTS_MD_CAP = 32 KiB`). Browser tabs assemble
nothing locally; a project-bound web chat's chain is fetched machine-
mediated through one journaled `read_file` dispatch at turn start, cached
per project folder under a 10-minute TTL, with the turn proceeding without
it when the machine is offline.

## 12. Integrations

Per `crates/server/src/integrations.rs`, `crates/server/src/integrations/*`, 
`worker/mcp_pool.rs`, `http/integration_tools.rs`.

**SRS-43 — One resolution path.**
Turn start resolves every enabled integration row into the same journaled
`PluginTurn` snapshot (namespaced tool specs `int_<slug>_<tool>`, classes,
row config, secret names, identity key) regardless of kind. Built-in
connectors execute in-process; MCP tools execute through the pooled MCP
connection (`mcp_pool.rs`: PoolKey {slug, url, acting_as, secrets
fingerprint}, 600 s TTL, 10 s connect timeout) — MCP is a special case of
the one interface, not a parallel path. A broken integration contributes
nothing to the turn and logs a warning.

**SRS-44 — Bundle format.**
Registry bundles carry a manifest: slug, version, description, auth
(`secret_names`, optional `identity_key`), settings field specs (name, kind
`string|text|number|boolean|secret`, label/required/default), per-tool
classes (`read|write|admin`), optional triggers and cookbook skill slugs.
Validation (`validate_v2`) enforces absolute MCP URLs, allowed auth kinds,
valid classes, and namespaced tool names ≤ 64 chars. The manifest's class
is the visibility floor: per-tool curation can only tighten it.

**SRS-45 — Secrets.**
Credentials live encrypted (AES-256-GCM, master key) in
`integration_secrets` keyed (org, integration, name) with a masked preview
for display; they appear in no listing, log, tool result, or API response.
A save runs the connector's live `test_connection` against the merged
values in memory and persists only on success; enabling requires every
declared secret present.

**SRS-46 — Identity envelope and per-tool curation.**
Every tool call carries the identity headers (`x-guild-org`, 
`x-guild-caller`, `x-guild-acting-as`, `x-guild-call-id`); `acting_as`
joins on email, and only an admin may override it to another member. The
admin's per-tool config (`{enabled, approval}` per tool on the integration
row) is the source of truth for exposure and approval: disabled tools are
invisible to the model and the script API; `always_ask` forces the approval
gate ahead of the user policy; `always_allow` lets the call flow with no
approval gate regardless of the chat's approval mode or the user policy —
the org's grant for non-sensitive tools (read-class tools flow by default
already; this also covers write/admin-class tools the org deems safe);
adapter-declared tools default enabled
(covered by the reviewed manifest) while MCP-discovered tools land disabled
until curated.

**SRS-47 — Audit.**
Every integration tool call (chat or script) appends an org event
`integration.tool_called` {slug, tool, caller, acting_as, ok, via} in
addition to the thread's tool_result record; script calls attribute usage
and identity the same way, with API keys acting under their creating user's
role.

## 13. Security invariants

**SRS-48 — Org scoping on every store call.**
Every store query takes the caller's `org_id` (and, where user-scoped, the
user) and every HTTP handler resolves the caller through the session/API-
key extractor first; a foreign chat, project, machine, artifact, or
integration is a 404/403, never a data leak.

**SRS-49 — One policy surface.**
Exec policy, approvals, curation, and audit exist only inside the gateway
workflow (the funnel's gate step + the journaled approval gate). No client
path, engine path, or admin path re-implements them; client-sent system
prompts are forbidden (additive, server-capped context fields only).

**SRS-50 — Filesystem boundaries.**
The webview's only filesystem surface is the `fs.*` bridge allowlist
(SRS-15); model tool execution is scoped by the workdir (project folder or
per-chat sandbox dir); shell tools require the server allowlist flag;
exec-policy rules are compiled into the server binary from the checked-in
rule files (Starlark never links into the server runtime — the rules are
parsed at build time).

**SRS-51 — Token and ticket hygiene.**
Session tokens are opaque, sha256-hashed at rest, 30-day expiry, revocable;
WS tickets are single-use, 30 s TTL, in-memory only; long-lived tokens never
appear in upgrade query strings or access logs; CORS is an explicit
allowlist (same-origin plus the desktop webview origins and the dev
server); error details go to the log, not the response body.

## 14. Error handling + testing requirements

**SRS-52 — Typed errors.**
Each crate has typed error enums; stringly errors do not cross boundaries.
Tool failures surface to the model as tool results (the model reacts)
instead of crashing the run.

**SRS-53 — One HTTP error envelope.**
Every `/api/v1` error is `{"error": {"code", "message"}}` with an accurate
status (`crates/server/src/http/error.rs`); JSON-RPC uses standard error
codes plus an app base code, with protocol errors distinguishable from tool
errors.

**SRS-54 — Replay determinism.**
Workflow behavior is replay-stable: side effects ride journaled runs or
idempotent claims; dispatch identity (connection id) replays rather than
the side effect; the artifact id derives deterministically from chat + call
ids; forced-replay tests in CI fail on nondeterminism (dispatch
reservation, capture atomicity, spill idempotence, stop resolution).

**SRS-55 — Test infrastructure.**
Tests run against the shared host services with per-run isolated
databases/buckets (`GUILD_TEST_PG_URL`, `GUILD_TEST_CLICKHOUSE_URL`, 
`GUILD_TEST_S3_URL` and companions; stale `test_*` databases reaped on
first use) — never testcontainers. Protocol round-trip tests keep the Rust
and TS types in lockstep; the engine stdio suite is the contract test for
the daemon verbs; the TS modules carry pure unit tests (thread reducer,
context assembly, mention detection).
