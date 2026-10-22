# Persistent agents — design

Status: decisions settled; implementation starting.
Branch `feat/agents-vfs`, worktree `~/guild-wt/agents-vfs`, based on `develop`.

This is the living design doc for persistent agents: named agents that own a
durable workspace, a default conversation, additional conversations, and
scheduled routines. It is written before code and updated as decisions settle.

## End state

A user creates a named agent (instructions + model + tool allowlist). The agent
has:

- one **default thread** and any number of **additional threads**;
- a private **workspace** on JuiceFS (object storage backing) that its tools
  run in and that the user can browse and preview;
- an **always-on gVisor sandbox** for execution;
- **scheduled routines** (cron/interval) that run in an isolated context and
  may message the user by opening a new thread;
- **conversation search** across its own threads;
- an **activity log** of every run, including silent ones.

The agent persists across runtime restarts: files live in JuiceFS, history in
the durable journal, configuration in Postgres.

## Decisions

1. **Base**: new branch off `develop`; nothing is ported from
   `feat/persistent-agents` (its checkpoint/recovery/pause machinery is
   replaced). Its Agents UI is reference only.
2. **Agent entity**: org + owner, name, instructions, model, tools,
   visibility, created/updated. The creator becomes the **owner**. Visibility
   is chosen at configuration time: `private` (owner only), `team` (selected
   teams), `org` (every member). Every user will typically have at least one
   private agent; additional agents are shared to a team or the org. One model
   per agent, picked from the org's curated model catalog; routines and
   threads do not override it. Replaces `agent_sessions` (routes, store,
   table) — agents are the single workspace-binding concept.
3. **Threads**: one default thread plus additional threads, created by the
   user or by the agent. Threads are independent conversations; they do not
   share transcripts.
4. **Shared state** is the workspace. `memories/` is the convention for durable
   notes; the agent curates it explicitly. No hidden cross-thread context.
5. **Agent-initiated messages** start a new thread each. A trigger (manual or
   cron) creates a durable **run**; the agent may call `send_message` to open
   a thread, or stay silent.
6. **Conversation search**: Postgres FTS (`tsvector`) over the agent's own
   threads. Schema carries a nullable embedding column; embeddings are a later
   additive step. Tools: `conversations_search`, `conversation_read`.
7. **Sandbox**: one always-on gVisor sandbox per agent, read-write mount of the
   agent workspace. Server-side file browsing uses a read-only bind.
8. **Parallel turns** are allowed; all turns of an agent share the live
   workspace. A per-turn change journal records touched paths; when turns
   overlap, a conflict notice is delivered **to the agent's context**, not to
   the user.
9. **Workspace storage**: JuiceFS with object-storage backing and a Postgres
   metadata engine. Compose: a privileged `juicefs` sidecar mounts the volume
   into a host directory with `rshared` propagation; server and runner bind it;
   sandboxes get per-agent subpaths. Kubernetes: JuiceFS CSI driver (mount pod
   mode). No systemd dependency.
10. **File browser**: read-only in M1 (list, stat, text preview, image/PDF/CSV
    preview, download). It reads the same tree the tools use. Editing is a
    later decision (would flip the server mount to rw).
11. **Routines**: cron/interval only in M1 (no event sources). Scheduler is
    written fresh, modeled on OpenClaw: durable definitions, stable occurrence
    identity, transactional claiming, coalescing of missed intervals,
    retries with backoff, failure surfacing and auto-disable. 5-field cron +
    IANA timezone per routine (default: user timezone, fallback UTC); interval
    is sugar for cron; minimum interval 1 minute; 3 retry attempts per
    occurrence (30s/1m/5m); auto-disable after 10 consecutive failed
    occurrences; `(routine_id, scheduled_for)` is the idempotency key.
12. **Self-scheduled reminders**: the agent can create a one-shot reminder for
    itself (`schedule_reminder(at, prompt)` tool), carrying the context it
    needs at fire time. A reminder is a one-shot routine occurrence: it runs
    isolated, may `send_message` to the user, and is visible/cancelable in the
    Routines tab. Pending reminders are capped per agent (default 20).
13. **Routine context**: isolated. A run gets instructions, the routine prompt,
    the workspace, and conversation-search tools — not the default thread's
    transcript. The routine's default prompt content tells the agent to
    explore workspace memory and search its conversations when that is
    warranted.
14. **Activity log**: every run is recorded and user-browsable — including
    silent runs that did not message the user. The activity view is a
    friendly trace (trigger, start/end, model turns, tool calls, files
    touched, outcome, errors), not a developer trace viewer. Errors are
    captured here only: they do not create threads and do not notify.
15. **Naming**: thread titles are generated from the first user message (short,
    derived from that message, never "New chat"), and a manual rename locks the
    title. Run names come from the routine/trigger plus timestamp. Agents are
    user-named and never auto-renamed.
16. **Information architecture** (research-backed, Q16 = A): the rail is
    `Inbox · Chats · Agents · Projects · Activity · Skills · Settings`.
    - **Agent page**: Overview · Threads (default pinned) · Routines · Files ·
      Activity · Settings.
    - **Project page**: Threads · Files · Activity (existing folder/machine
      model).
    - **Thread**: transcript + run summary header + files dock.
    - **Run**: one execution record (`trigger ∈ message|routine|manual`),
      status, summary, error, steps, optional thread, canonical URL.
    - **Activity**: global reverse-chronological run log (all runs, including
      silent), with per-agent and per-project projections. Silent runs appear
      only here and under the agent.
    - **Inbox**: attention queue only (agent question, approval, failed
      routine, routine message); its badge counts attention items, not
      activity. Read state is per inbox item, not per thread.
    - A thread has exactly one owner: an agent or a project, never both.
      Agent threads also appear in the global Chats list (one object, two
      projections, one URL).
17. **Agent-to-agent delegation** (M1): a delegated run. An agent may call
    `delegate(agent, task, context?)`; the server creates a child run with
    `parent_run_id`, `delegate_agent_id`, `depth`, executed in the target
    agent's own sandbox and workspace. The child gets an isolated context
    (task text + optional artifact references + optional parent-thread
    summary), never a live transcript. It returns text plus artifact paths,
    which the parent copies into its workspace under `inbox/<run-id>/`.
    Effective permissions are the intersection of the parent run's scope and
    the target agent's grant, and the effective tool set is the intersection of
    the parent run's policy and the target agent's tool allowlist; no
    credentials are passed. Limits: depth 2, ≤3 children per run, no
    self-delegation, no cycles, spawn tool removed at the cap, per-root-run
    token/time budget. The parent thread shows a single "delegated to X" step
    linking to the child run; the child transcript is nested under the parent
    in Activity and is not a new top-level chat. Delegation is not a shared
    transcript, not free-form agent chat, and not the A2A protocol.
18. **Per-agent tool allowlist**: every agent has an explicit `tools`
    allowlist selected from the org's available tools (workspace/shell tools,
    web search, conversation search, `send_message`, `schedule_reminder`,
    `delegate`, and integration/MCP tools). A new agent starts with the safe
    baseline — workspace read/write/list, `conversations_search`,
    `send_message`, `schedule_reminder` — and the owner configures the rest
    during setup, with a "select all org tools" shortcut. Effective tools for
    any run are the agent's allowlist intersected with the org/integration
    policy and the requester's rights. Delegated child runs use the target
    agent's allowlist, never the parent's.
19. **Artifact transfer** (delegation): declared files only (≤20 per run). The
    server clones them into the parent's `inbox/<run-id>/`; files above 16 MiB
    stage in a shared `/tmp/delegations/<run-id>/` area first. **Nothing is
    cleaned up automatically** — no TTL sweep, no background GC. The agent
    explicitly releases staging (`release_artifacts(run_id)`) or promotes the
    files into its inbox; the user can delete either via the file browser.
    Quota accounting counts metadata/inodes, not shared bytes.
20. **Lifecycle**: agents can be **archived** (sandbox stopped, routines
    suspended, hidden from default lists; workspace, threads and runs retained;
    restore is one click) and **deleted**. Deletion is a two-phase operation:
    the owner (or an admin) marks the agent deleted, which stops the sandbox,
    suspends routines, hides it, and starts a **grace period** (default 30
    days, org-configurable) during which admins are notified and can restore
    it. Only after the grace period is the workspace (JuiceFS subpath),
    threads, runs, routines and grants permanently purged. An export (workspace
    tarball + threads/runs JSONL) is offered at deletion time. When an owner
    leaves the org, their agents are suspended and flagged for reassignment,
    never auto-deleted.
21. **Resource limits**: per sandbox 2 vCPU, 2 GiB RAM, 512 pids (runner
    defaults, env-tunable: `GUILD_SANDBOX_CPUS`, `_MEMORY_MB`, `_PIDS`);
    per-agent workspace quota 50 GiB (JuiceFS directory quota,
    `GUILD_AGENT_WORKSPACE_GIB`). Agent count is unbounded — limits are
    workspace quota and storage budget. No tier UI; `resources` is recorded
    per agent but not enforced yet.
22. **UI quality bar**: M1 ships a finished UI, not a prototype — existing
    design system (`packages/ui`, Inter/JetBrains Mono, semantic tokens),
    URL-state navigation (every page/tab/panel has a route, deep links and
    back/forward work), loading/empty/error states, responsive to mobile.

## Data model

```
agents(id, org_id, owner_user_id, name, instructions, model,
       tools jsonb, visibility ∈ private|team|org,
       resources jsonb, status ∈ active|archived|deleting|deleted,
       deleted_at, purge_after, created_at, updated_at)

agent_grants(agent_id, user_id, role ∈ owner|editor|user|viewer)
agent_team_grants(agent_id, team_id, role ∈ editor|user|viewer)

agent_threads(id, agent_id, title, title_locked bool,
              kind ∈ default|thread|routine_run,
              created_at, last_activity_at)

agent_runs(id, agent_id, thread_id?, routine_id?, parent_run_id?,
           delegate_agent_id?, depth int,
           trigger ∈ message|routine|manual|delegation,
           status ∈ queued|running|succeeded|failed|silent|skipped,
           summary, error_code, error_message, error_step,
           tokens, started_at, finished_at, created_at)

agent_routines(id, agent_id, name, kind ∈ cron|once, schedule, timezone,
               run_at, prompt, context ∈ isolated,
               enabled, next_run_at, created_at, updated_at)

agent_routine_occurrences(id, routine_id, scheduled_for, run_id,
                          status ∈ pending|claimed|done|failed|skipped,
                          attempts, last_error,
                          UNIQUE(routine_id, scheduled_for))

agent_thread_chunks(id, thread_id, agent_id, seq_from, seq_to, ts, text,
                    tsv tsvector, embedding vector NULL)

agent_workspace_turns(id, agent_id, thread_id, run_id,
                      started_at, finished_at, paths text[])

agent_notices(id, org_id, agent_id?, user_id?, kind, payload jsonb,
              read_at, created_at)   -- inbox
```

`agent_grants`/`agent_team_grants` exist from day one even though M1's
visibility rules mostly resolve through `visibility` + team membership.

## Runtime

- **Workspace resolution**: `chat → agent_thread → agent → workspace subpath`
  (`agents/<org>/<agentId>`). A turn without an agent is a plain chat
  (existing behavior). The old `agent_sessions` resolution is removed.
- **Sandbox**: the runner keeps one container per agent, labeled
  `guild-sbx-agent-<id>`, mounting the agent subpath read-write. Agent
  containers are exempt from idle reap; archive/delete stops them.
- **Turns**: a user message or routine run creates an `agent_runs` row before
  admission. Parallel turns are allowed; each turn is a separate harness
  conversation, all inside the same sandbox and workspace.
- **Tools added to the harness**: `send_message`, `schedule_reminder`,
  `delegate`, `release_artifacts`, `conversations_search`,
  `conversation_read`. `send_message` creates a thread (or posts into a given
  thread for manual runs), writes the assistant message, sets unread.
- **Silent runs**: no `send_message` → run status `silent`, no thread, no
  notice. The activity row is the only trace.
- **Conflict journal**: tool-reported paths (`write`, `edit`, `apply_patch`,
  shell-declared writes where available) are recorded per turn. When turn B
  writes a path turn A touched since B's baseline, B receives a tool-result
  notice: "thread A modified `path` — re-read before editing"; A receives the
  reciprocal notice if still running. No user notification.
- **Search indexing**: after each committed turn, chunk user+assistant text and
  insert into `agent_thread_chunks` with `tsv`. FTS only in M1.
- **Activity**: run rows + derived steps from thread events. The run detail
  shows trigger, status, summary, tool calls, files touched, error, and links
  to the thread/artifacts.

## Scheduler

- A single loop (server process for now, worker later) ticks every 15 s.
- Claims due occurrences with `SELECT … FOR UPDATE SKIP LOCKED`, inserts the
  run, and executes it through the normal admission path.
- On startup and after long gaps: coalesce missed occurrences — run the most
  recent, mark earlier ones `skipped`.
- Retries: 3 attempts (30 s / 1 m / 5 m), same occurrence identity.
- After 10 consecutive failed occurrences: routine disabled, notice written.
- One-shot reminders are `kind=once` routines with a single occurrence.
- Timezone: IANA per routine; DST handled by the cron library; occurrence
  identity uses the scheduled instant.

## Delegation

- `delegate(agent, task, context?)` resolves the target by name/id within the
  org, checks visibility/grants against the **requester**, cycle/self checks,
  depth ≤ 2, ≤ 3 children per run.
- Child run executes in the target agent's sandbox/workspace with the target's
  tool allowlist ∩ org policy ∩ parent effective tools.
- Context: task text, optional artifact references, optional parent-thread
  summary. No transcript, no credentials.
- Result: text + up to 20 declared files. Server clones them into the parent's
  `inbox/<run-id>/`; >16 MiB files stage under `/tmp/delegations/<run-id>/`
  first. No automatic cleanup; `release_artifacts` or user deletion.
- UX: one "delegated to X" step in the parent thread; child run nested in
  Activity; Inbox item only for child approval/failure.

## Conversation search

- `conversations_search(query, limit?, since?, until?)` → snippets with
  `thread_id`, thread title, timestamp, score. Max 20 results, 700-char
  snippets, query ≤ 512 chars.
- `conversation_read(thread_id, from?, to?)` → bounded transcript excerpt
  (max 200 messages, 20k chars), only threads owned by the calling agent.
- Scope enforced in SQL by `agent_id`; never post-filtered.

## File browser

- `GET /agents/:id/files?path=` → directory listing (name, kind, size, mtime,
  symlink flag; symlinks shown, never followed).
- `GET /agents/:id/files/content?path=` → text preview (≤1 MiB, syntax
  highlighted), image/PDF inline, otherwise download.
- `GET /agents/:id/files/download?path=` → streamed download (≤64 MiB).
- Path validation: reject absolute, `..`, and any path whose realpath escapes
  the agent root. Symlinks are opaque: displayed, not traversed.
- Hidden dirs (`.guild`, `.git`, `node_modules`) hidden by default with a
  toggle.

## API surface

```
POST   /api/v1/agents                     create
GET    /api/v1/agents                     list (visibility-filtered)
GET    /api/v1/agents/:id
PATCH  /api/v1/agents/:id                 name, instructions, model, tools, visibility
POST   /api/v1/agents/:id/archive|restore
DELETE /api/v1/agents/:id                 two-phase delete
POST   /api/v1/agents/:id/threads         create thread
GET    /api/v1/agents/:id/threads
POST   /api/v1/agents/:id/turns           send message (SSE)
GET    /api/v1/agents/:id/files[/content|/download]
GET    /api/v1/agents/:id/routines | POST/PATCH/DELETE /routines/:rid | POST /routines/:rid/run
GET    /api/v1/agents/:id/runs
GET    /api/v1/runs/:id
GET    /api/v1/activity?agent=&status=&since=
GET    /api/v1/inbox | POST /api/v1/inbox/:id/read|snooze
```

All routes enforce org + agent visibility + role. Admin sees all; owner manages
config; users chat and read threads they can see.

## UI map

```
/agents                          agent directory (cards: name, owner, visibility, last activity)
/agents/new                      creation flow: name → instructions → model → tools → visibility
/agents/:id                      agent page, tab = overview
/agents/:id/threads              thread list; default pinned
/agents/:id/threads/:threadId    thread transcript
/agents/:id/routines             routines list + run history
/agents/:id/routines/:rid        routine config
/agents/:id/files                file browser (breadcrumbs, preview pane)
/agents/:id/files/*path          file/dir deep link
/agents/:id/activity             agent run log
/agents/:id/settings             instructions, model, tools, visibility, danger zone
/activity                        global run log
/inbox                           attention queue
/runs/:runId                     run detail drawer/page
```

All navigation is URL state. Threads also appear in `/chats` (filtered by
agent) and Activity links to the same canonical thread/run URLs.

## Security

- Visibility + grants checked on every route and every tool call.
- Workspace isolation: one subpath per agent; no sibling access; browser
  read-only; symlinks never followed.
- Tool allowlist ∩ org/integration policy ∩ requester rights; exec policy and
  approval gates unchanged.
- Routines run with the agent's baseline allowlist and declared audience; no
  owner credentials.
- Audit: every run records requester (`user|routine|agent`), agent, trigger,
  scopes, tool calls, error. Activity is append-only.
- Egress: sandbox proxy allowlist; agents cannot mount FUSE; no host paths or
  S3 credentials in the sandbox.

## Operations

- Compose: `juicefs` sidecar (privileged, `/dev/fuse`, rshared host dir),
  healthcheck; server binds the volume read-only at `/workspaces`; runner
  binds read-write; sandboxes get subpaths. Bootstrap creates the host dir.
- JuiceFS metadata lives in a dedicated Postgres database (`guild_meta`),
  separate from the app database.
- Kubernetes: JuiceFS CSI driver, static PV + subPath per agent.
- Quotas: `juicefs quota set` per agent dir; org disk cap in the admin UI.
- Backup: object storage durability + JuiceFS trash; agent archive keeps data;
  delete purges after grace.
- GC: `juicefs gc` for orphaned blocks after clone/delete; no automatic
  deletion of delegation staging (explicit release only).

## Migration

- Migration 0078: drop `agent_sessions` (table, routes, store, tests); create
  the tables above.
- Existing agent-session workspaces (`workspaces/<org>/<name>`) are left on the
  old volume untouched; they are not imported.

## Milestones

- **M0 — foundation**: schema/migrations, agent stores, JuiceFS compose
  sidecar + volume, runner agent mounts (always-on), isolated instance,
  removal of `agent_sessions`.
- **M1 — agents surface**: creation flow, agent page, threads (default +
  additional), turns, file browser, conversation search, activity, inbox,
  settings. Finished UI.
- **M2 — routines**: scheduler, routines CRUD, reminders, run history,
  notifications.
- **M3 — delegation**: `delegate` tool, child runs, artifact transfer,
  conflict journal, nested activity.
- **M4 — verification**: isolated compose instance, gVisor e2e, restart
  recovery, quotas, desktop release.

## Remaining implementation-level questions

- Exact cron library and DST tests.
- Conflict-journal coverage for shell writes.
- Chunk size/overlap for FTS indexing.
- Whether `send_message` can post into an existing thread for manual runs.
- Inbox item kinds and read/snooze UI details.
