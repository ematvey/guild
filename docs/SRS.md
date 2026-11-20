# Guild — Software Requirements Specification (SRS)

The system-level contracts that satisfy `docs/PRD.md`. Every claim is
verified against the code. Present-tense requirements only; identifiers are
stable (`SRS-n`) for citation.

> The cloud server is TypeScript (`apps/server`); `crates/*` paths name the
> local engine and the shared protocol crates.

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
| 15 | Realtime UI | SRS-56 |

---

## 1. Architecture invariants

**SRS-1 — One agent loop.**
Exactly one agent loop exists: the durable gateway workflow (the
pi-durable `Harness` owned by `GuildRuntime` in
`apps/server/src/harness/runtime.ts`). Tool looping, model-turn sequencing,
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
Adding an executor is a new arm of `ExecutorKind`
(`apps/server/src/machines/dispatch.ts`) and a dispatch-shape change; it
never forks the loop. All arms share the same
exec-policy and approval gates (the sandbox arm runs them before dispatch;
the desktop arm runs them before suspension).

## 2. Executor taxonomy

**SRS-6 — Two executors.**
`ExecutorKind` has two variants (`apps/server/src/machines/dispatch.ts`):
`machine` and `server`. Each tool call resolves to one executor at turn
time; one chat may carry tools from both (SRS-8).

**SRS-7 — Machine executor.**
The `machine` executor dispatches over the machine's singleton WebSocket to
the desktop backend, which executes through
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

**SRS-8 — Server executor.**
The `server` executor runs the same client-tool specs in a gVisor sandbox
via the `sandbox-runner` service: a plain chat gets
`chats/<org>/<conversationId>`, an agent chat gets the agent workspace
`agents/<org>/<agent>`. Every unbound chat (web or desktop origin) uses it. The static exec-policy gate and the interactive approval
gate both run before execution; `execute` additionally requires the server
shell flag (`allow_shell_tools`).

Every chat keeps one file-tool set. Without `machine` a call acts on the
agent's workspace in the sandbox; `machine` names one of the Member's paired
computers and `cwd` the folder on it
(`apps/server/src/harness/agent-tools.ts`). A Machine call counts as
machine-side for the shell allowlist and takes an Approval card; a call
without `machine` stays inside the sandbox and takes the batch contract.

**SRS-9 — No third executor.**
The batch workspace executor is removed. Workspace execution belongs to
persistent agents; plain
chats use the server sandbox of SRS-8.

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
The backend owns the machine link (`crates/app-server/src/machine_link.rs`):
one WebSocket to the server, `ToolDispatch` receive, `ToolRegistry`
execution, `ToolResult` return, identity persistence in `token.json`,
registry metadata reporting (fingerprint, OS, app version). The link runs
inside the app process (single-process design); a headless host can run
`Guild daemon` as a systemd user unit instead.

**SRS-15 — File bridge with an explicit allowlist.**
The `fs.*` verbs (`crates/app-server/src/fs_bridge.rs`) are the only filesystem surface the
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
provenance sidecar writes for publish/install/uninstall. Desktop updater artifacts
carry minisign signatures verified against the client’s baked public key. The
server checks GitHub metadata and serves only approved releases compatible with
its own build version (`apps/server/src/platform/http/releases.ts`). Guild metadata lives in
manifests and sidecars, never inside SKILL.md.

**SRS-17 — Auth store.**
`crates/app-server/src/auth_state.rs` owns token.json + machine identity + link publication: one
`transition` method per mutation (login, pair, identify, sign-out) applies
mutate ⇒ persist ⇒ publish; the RPC verbs are thin over it. The webview
holds its own session token for direct HTTP; the backend uses its stored
credentials for the machine socket.

**SRS-18 — Agent turns run server-side.**
The TS server's durable harness drives every agent turn; the engine never
runs a model loop. The engine's part is executing the tools the server
dispatches over the machine link, context prepare, skills sync, and the
`fs.*` file bridge. Its one completion entry point is the CLI's
`chat.send`: a plain (tool-less) completion over the durable gateway
workflow, its `StreamEvent`s mapped onto `chat.delta` / `chat.done`
(`crates/app-server/src/chat_stream.rs`). No second completion loop
exists.

## 5. Machine registry + WS transport

**SRS-19 — Durable machine registry.**
The `machines` table is one row per pairing: `machine_id` (PK,
server-issued at pairing), `org_id`, `user_id`, `label`, 
`hardware_fingerprint`, `os`, `os_version`, `app_version`, `last_ip`, 
`first_connected_at`, `last_connected_at`, `last_seen_at`, `re_paired_at`
(`apps/server/migrations/0046_machines.sql`). Writes happen on connect and
pairing adoption; `last_seen_at` refreshes on a 30 s throttle off socket
pings; disconnect writes nothing (absence of the socket is the disconnect).

**SRS-20 — Singleton machine socket; a live slot is held.**
Exactly one socket per `machine_id`. A live slot is held, not displaced: a
connect from a different instance is rejected `displaced` and the holder
keeps the slot. A reconnect of the same instance replaces its own zombie
slot, which heals an honest blip. A connect from a different user is
rejected `foreign_owner`, and a `resume=true` from a stale instance is
rejected.

**SRS-21 — Ticket auth.**
Both browsers and machines connect to `/api/v1/ws` with a single-use,
30-second-TTL ticket minted over authenticated HTTP
(`POST /api/v1/ws/ticket`); raw tokens never appear in the upgrade query
string. Ticket state is in-memory (a restart invalidates tickets; clients
mint a fresh one per connect). Session expiry mid-connection sends
`auth_required` and closes.

**SRS-22 — Sanity cap.**
At most 32 sockets per user (`apps/server/src/hub/live.ts`,
`MAX_SOCKETS_PER_USER`); over-limit
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
`sync_begin → thread_state → subagent_tree → sync_done`, where `thread_state`
is the atomic authoritative view (the newest 120 durable events with
`has_more_events`, in-flight buffers, project fields) under a `seq` watermark,
and `subagent_tree` is the chat's thread subtree with each node's latest run
status. Older events come from
`GET /api/v1/threads/{id}/events?before=&limit=`. Clients apply a
`thread_state` only when its watermark is strictly newer than the last
applied view.

**SRS-25 — Log-then-broadcast.**
A command (send, approval, project change) is written to the durable log
first; the commit fires `pg_notify('guild_thread_committed')`, and the feed
re-captures and broadcasts the committed `thread_state` to every socket of
the user, including the sender's. The DB thread log is the source of truth;
the socket is fan-out only.

## 6. Data model

**SRS-26 — Postgres holds the records.**
Live tables (verify against `apps/server/src/platform/store/` +
`apps/server/migrations/`), grouped by area:

- Identity: `orgs`, `users`, `teams`, `team_members`, `sessions` (opaque
  tokens, sha256-hashed), `oidc_configs`, `pairing_tokens`.
- Gateway: `provider_keys` (encrypted secrets), `model_routes`, `api_keys`.
- Threads: `chats`, `thread_events` (the history log — there is no separate
  messages table), `chat_reads`, `attachments`, the `chat_*` projection
  tables, `conversations`, `entries`, `submissions`, `tasks`,
  `turn_commands`, `documents` + `document_revisions`.
- Projects and machines: `projects` (id, org_id, user_id, name — display
  label, duplicates allowed, folder, machine_id), `machines` (SRS-19).
- Registry and skills: `registry_items` + `registry_versions` (with
  `reviewed_version` + `reviewed_bundle_sha256` binding approval to
  content), `skill_installs`.
- Integrations: `integrations`, `integration_secrets` (AES-256-GCM, masked
  preview column), `user_mcp_servers`.
- Agents: `agents`, `agent_grants`, `agent_team_grants`, `agent_threads`,
  `agent_thread_chunks`, `agent_runs`, `agent_routines`,
  `agent_routine_occurrences`, `agent_notices`,
  `agent_delegation_artifacts`, `agent_workspace_turns`.
- Durable: `durable_commits`, `durable_metadata`, `durable_schema`,
  `record_ids`.
- Ops: `events` (org audit log), `releases`, `org_kv`/`server_kv`/`user_kv`
  (incl. the `tool_dispatch:` claim keys), `tool_artifacts`,
  `schema_history`, `live_projection_repairs`.

The `routines`, `routine_runs` and `routine_schedule_starts` tables are
leftovers from the removed integration routines; no code reads them.
The `llm_calls` table named in older notes has no live writer; the live LLM
record is an `llm` span in `agent_spans` (SRS-27). Schema changes go through
embedded, checksummed migrations applied under an advisory lock.

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

**SRS-29 — The durable store holds only the active subset.**
The durable state of in-flight runs (current step, pending awaits, timers)
lives in pi-durable's Postgres tables (`durable_commits`,
`durable_metadata`); on completion, results persist to the domain tables and
the journal retires. No long-term record lives only in the durable journal.

## 7. WS protocol

Per `crates/protocol/src/ws.rs` + `apps/server/src/http/ws.ts` and the
`apps/server/src/hub/` feed.
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
| `subagent_tree` | `chat_id, nodes[]` | The chat's thread subtree with each node's latest run status; pushed on sync and on every create, status change or close in the subtree. |

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
`/openai/v1/chat/completions`), per `apps/server/src/platform/http/register.ts`:

- Health: `GET /api/v1/health`.
- Auth/identity: `/api/v1/auth/{bootstrap,login,me,refresh,pair,oidc/*,pairing-tokens*}`, `GET /api/v1/me/approval`.
- Threads: `POST|GET /api/v1/threads`, `GET|PATCH /api/v1/threads/{id}`,
  `GET /api/v1/threads/{id}/events` (read-only: rows are projected from the
  conversation), `/threads/{id}/{project,approval,
  read,agent,context}`, `/threads/{id}/pending/{messageId}/steer`,
  `/threads/{id}/compact`, `/threads/{id}/approvals/{callId}`,
  `/threads/{id}/attachments`, `/threads/{id}/tool_artifacts`. The
  `/api/v1/gateway/chat/*` forms remain as aliases for older clients.
- Agents: `POST|GET /api/v1/agents`, `GET|PATCH|DELETE /api/v1/agents/{id}`,
  `.../agents/{id}/{threads,routines,files,runs}`, `GET /api/v1/agents/tools`,
  `GET /api/v1/inbox`, `GET /api/v1/runs/{id}`.
- Activity: `GET /api/v1/activity/{traces,spans,sessions,summary}`.
- Skills: `/api/v1/skills*` (incl. `installs`, `sync-payload`, `teams`,
  `activity`).
- MCP: `/api/v1/mcp/{servers,probe}`.
- Me: `/api/v1/me/{approval,onboarded,settings}`; machines:
  `GET /api/v1/machines`.
- Projects: `POST|GET /api/v1/projects`, `PUT|DELETE /api/v1/projects/{id}`.
- Gateway: `GET /api/v1/gateway/models`, `GET /api/v1/models`,
  `POST /api/v1/gateway/chat`,
  `POST /api/v1/gateway/chat/{id}/{stop,compact}`,
  `POST /api/v1/gateway/chat/{id}/approvals/{callId}`.
- Attachments/artifacts: `GET|POST /api/v1/attachments*`, 
  `GET /api/v1/tool_artifacts/{id}`.
- Registry: `POST|GET /api/v1/registry/{kind}`, 
  `GET /api/v1/registry/{kind}/{slug}`, 
  `GET .../{version}/bundle`, `POST .../install`, `POST .../review`.
- Releases: `GET /api/v1/releases`, `/api/v1/releases/{id}/download*`, 
  `/api/v1/updates/latest.json`, admin GitHub approval at `/api/v1/admin/releases/github`,
  and admin metadata listing/deletion under `/api/v1/admin/releases`.
- Integrations script API: `GET /api/v1/integrations`, 
  `GET /api/v1/integrations/{slug}/tools`, 
  `POST /api/v1/integrations/{slug}/tools/{tool}`.
- Agent routines: `GET|POST /api/v1/agents/{id}/routines`,
  `GET|PATCH|DELETE /api/v1/agents/{id}/routines/{rid}`,
  `POST .../routines/{rid}/run`, `GET .../routines/{rid}/runs`.
- Usage: `GET /api/v1/usage{,/summary,/series}`.
- Org events: `GET /api/v1/events`.
- Admin: `/api/v1/admin/{users,teams,api-keys,oidc,gateway/*,integrations*}` — 
  integrations include `GET|PUT .../{id}/tools[/{tool}]` (curation) and 
  `GET .../{id}/secrets` (masked), plus 
  `/api/v1/admin/{approval-policy-prompt,assistant-prompt}`.
- WebSocket: `POST /api/v1/ws/ticket`, `GET /api/v1/ws` (upgrade).

## 9. Daemon JSON-RPC verbs

**SRS-34 — Engine protocol verbs.**
Line-delimited JSON-RPC 2.0 with a `protocol` version field on every
envelope (`crates/protocol/src/rpc.rs`, PROTOCOL_VERSION = 1; BUILD_ID
handshake in `daemon.hello`). Dispatch table in
`crates/app-server/src/jsonrpc_loop.rs`:

- Auth/session: `login`, `pair`, `session.info`, `session.clear`, 
  `workspace.list`, `workspace.switch`, `machine.identify`.
- Chat: `chat.send` (the CLI's `chat` verb).
- Registry: `registry.publish`, `registry.install`, `registry.uninstall`.
- File bridge: `fs.scopes`, `fs.read_text`, `fs.list_dir`, `fs.exists`, 
  `fs.write_text`.
- Lifecycle (CLI handshake): `daemon.hello`, `daemon.shutdown`.

Unknown methods return a standard RPC error. Server-push events ride the
same connection (`chat.delta`, `chat.done` — the mapping in
`crates/app-server/src/chat_stream.rs`).

## 10. Tool artifacts

Per `apps/server/src/chats/spill.ts`, `crates/guild-core/src/tools/artifacts.rs`,
`crates/app-server/src/artifacts.rs`.

**SRS-35 — Spill trigger and ceilings.**
One choke point where a server-side tool outcome becomes a
`ThreadEvent::ToolResult`: serialized content above 64 KiB spills into an
artifact. A tool that carries bytes (`ToolOutcome.file`) writes them into the
call's environment at the path the call names, and never spills. Per-tool caps
are storage ceilings, not history protection (the generic HTTP tool's 1 MiB
ceiling spills instead of truncating). Local tools keep inline caps and never
spill.

**SRS-36 — Storage and event shape.**
A spilled result is a `tool_artifacts` row (id, org_id, chat_id, filename, 
content_type, size_bytes, object_key UNIQUE, tool_name, call_id) plus bytes
in object storage. The event carries `artifact_id: Option<Uuid>` (never the
storage key) and a meta card — `card: "artifact"` with `id`, `filename`, 
`content_type`, `size_bytes`, `path` (existing tool meta keys preserved) —
which drives the UI download card.

**SRS-37 — Model-facing pointer and path contract.**
An oversized result's model-facing content is pointer text naming the
workspace-relative path `.guild/artifacts/<chat_id>/<filename>`, with "First
2 KiB of N KiB" and the head excerpt. A tool that carries bytes names the real
path it wrote instead; there is no pointer.
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

Per `apps/desktop/src/lib/skills.ts` + `skill-mention.ts` (TS owns the
logic; Rust only touches bytes through `fs.*`), with the server as the
enforcement cap (`apps/server/src/harness/runtime.ts`).

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
The rendered index (name — description per skill) is capped at 8 KiB
(8192 bytes):
description clipping first (120/60/24 chars tiers), then tail-dropping with
an "N skills omitted" notice. The server re-caps client-sent `skills_index`
at the same budget before rendering — the server stays the enforcement
point, and the client never sends a system prompt (both fields are
additive, server-framed segments).

**SRS-42 — Agent instructions.**
A thread's instructions come from two sources, and each file is a tagged
block carrying its full path, so the model can tell them apart.

The agent workspace (`/workspace`, `AGENT_WORKSPACE_PATH`) holds
`AGENTS.md` (required) and `MEMORY.md` (optional), plus the `memories/`
directory. The server reads them on every turn, caps each at
`FILE_MAX_CHARS = 8 KiB` and the set at `TOTAL_MAX_CHARS = 24 KiB`
(`apps/server/src/agents/workspace-config.ts`), and renders them inside
one section:

```
<agent_workspace path="/workspace">
<agent_workspace_file path="/workspace/AGENTS.md">
...file body...
</agent_workspace_file>
</agent_workspace>
```

The agent's name and description come from the `agents` row, not from a
workspace file. The description is the agent's purpose: the UI shows it to
users, and the instructions and `list_agents` give it to callers.

A desktop turn adds the user's project context: the global config-dir file
(`AGENTS.override.md` beats `AGENTS.md`) plus one file per directory from
the git root down to the working dir, under
`PROJECT_DOC_MAX_BYTES = 32 KiB` (`context.ts`). The client renders one
tagged block per file and the server wraps them in the pi section header:

```
<project_context>
Project-specific instructions and guidelines:
...
<project_instructions path="/repo/AGENTS.md">
...file body...
</project_instructions>
</project_context>
```

The server cuts the chain at `PROJECT_INSTRUCTIONS_MAX_CHARS = 32 KiB`
and keeps the last chain per conversation, so a resumed run renders the
same instructions. Browser and server turns send no chain and get the
workspace files alone.

## 12. Integrations

Per `apps/server/src/platform/integrations/` and
`apps/server/src/platform/http/integration_tools.ts`.

**SRS-43 — One resolution path.**
Turn start resolves every enabled integration row into the same journaled
`PluginTurn` snapshot (namespaced tool specs `int_<slug>_<tool>`, classes,
row config, secret names, identity key) regardless of kind. Built-in
connectors execute in-process; MCP tools execute through the pooled MCP
connection (`apps/server/src/platform/integrations/mcp.ts`: the pool key is
{slug, url, acting_as, secrets
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
workflow (`apps/server/src/harness/runtime.ts` plus the journaled
approval gate). No client
path, engine path, or admin path re-implements them; client-sent system
prompts are forbidden (additive, server-capped context fields only).

**SRS-50 — Filesystem boundaries.**
The webview's only filesystem surface is the `fs.*` bridge allowlist
(SRS-15); model tool execution is scoped by the workdir (project folder or
per-chat sandbox dir); shell tools require the server allowlist flag;
exec-policy rules are parsed at server start from the checked-in rule file
(`apps/server/assets/exec_policy_base.rules`, `apps/server/src/execpolicy/`).

**SRS-51 — Token and ticket hygiene.**
Session tokens are opaque, sha256-hashed at rest, 30-day expiry, revocable;
WS tickets are single-use, 30 s TTL, in-memory only; long-lived tokens never
appear in upgrade query strings or access logs; CORS is an explicit
allowlist (same-origin plus the desktop webview origins and the dev
server); error details go to the log, not the response body.

## 14. Error handling + testing requirements

**SRS-52 — Typed errors.**
Each Rust crate has typed error enums, and the TS server throws `ApiError`
with a code; stringly errors do not cross boundaries. Tool failures surface
to the model as tool results (the model reacts) instead of crashing the
run.

**SRS-53 — One HTTP error envelope.**
Every `/api/v1` error is `{"error": {"code", "message"}}` with an accurate
status (`apps/server/src/platform/http/error.ts`); JSON-RPC uses standard error
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

## 15. Realtime UI

**SRS-56 — Every live UI update rides the member socket.**
Any state a user sees change in a chat or thread is pushed as a
`WsServerMsg` frame on the member socket: the first view inside the `sync`
bracket, later changes on a Postgres NOTIFY. This covers messages
(`thread_state`, `thread_events`), generation progress, chat status, the
chat list, presence, and the thread subtree (`subagent_tree`). A client
never polls an HTTP endpoint for state the socket carries; a reconnect
re-syncs the open chat. A change in a child thread is pushed to every
ancestor chat that displays it, because each of those chats may be open on
some device.
