# PLAN — current state and future directions

Guild is a self-hosted Codex/Cowork replacement: a TypeScript cloud
server, a Rust local engine with shared protocol/core crates, and a Tauri
desktop client. Product requirements live in `docs/PRD.md`, system contracts in
`docs/SRS.md`, deploy recipes in `docs/deploy-nuances.md`, client release
recipes in `docs/clients.md`. Repo conventions are in `AGENTS.md`.

This file tracks where the project stands and where it is going. The
decision log is the changelog: each entry says what changed and why, newest
first. Code comments describe only the present.

## Where things stand

- **Server:** a TypeScript Fastify app on `pi-durable`, run by Bun with no
  compile step. The compose stack on `:18080` (`deploy/compose`) serves the
  API and the chat SPA baked into the image from `apps/desktop/dist`. State
  lives on the host services: Postgres db `guild`, ClickHouse for traces and
  usage, rustfs for objects. Agent workspaces ride a JuiceFS volume; tools
  run in gVisor sandboxes via `sandbox-runner`.
- **Version:** develop is at 0.6.49. Prod is a separate checkout
  (`~/guild-live`, branch master, port 18081), also at 0.6.49, and stays
  in supervisor mode; dev runs worker mode (`GUILD_WORKER_MODE=on`).
- **Clients:** desktop 0.6.49 is published on the dev updater manifest for
  all four platforms (six artifacts: Windows NSIS, Linux AppImage, macOS
  aarch64 and x86_64 DMG plus their updater bundles), minisign-signed.
  Installed clients pick it up on relaunch. Releases stay dev-controlled and
  deliberate.
- **Wire:** the client↔server contract is typed end to end, and
  `protocol/*.schema.json` is the contract: Rust and TypeScript are
  hand-written from it. Each client release is tagged `client-v<version>`
  (`client-v0.6.42` through `client-v0.6.49`), and `protocol/check.mjs`
  fails on a schema change that client cannot read. The model itself still carries migration history:
  dead stream variants, one event mapped twice, `Json` where a shape exists.
  A refactor defines the domain model before the wide release; the plan is
  `docs/plans/2026-10-28-wire-domain-model.md`. The wide release waits for
  it, because after the release every change costs a version step.
- **Product surface:** private threads and shared persistent agents; org
  skills with provenance; projects, machines and agent routines. Admin
  sections live inside Settings (`/settings/<section>`); there is no
  separate admin app. Observability is the Activity surface, fed by traces
  and spans from ClickHouse.
- **Quality baseline:** `scripts/check.sh` runs all of it in one pass:
  `cargo nextest run --workspace`, the TS server suite
  (`npm test --workspace apps/server`), desktop vitest, strict clippy
  (`--all-targets`), `cargo fmt --check`, the Windows compile check
  (`scripts/check-windows.sh`), `node protocol/check.mjs`,
  `npm run coherence` and `tsc --noEmit` over the server, desktop, wire and
  ui trees. A `biome.json` is committed but not yet run by the gate.

## Next steps (ordered)

1. **Finish the worker-mode soak and flip prod.** Dev serves turns through
   forked workers, so every agent turn rides this path. Still unverified:
   idle reap, and live approval, compaction and steering inside a worker
   turn. Prod stays on the supervisor until these pass.
2. **Enforce agent resource limits, or drop the field.** Every agent records
   `resources` (1 vCPU / 2 GiB / 256 pids / 50 GiB), but the sandbox runner
   ignores it and uses its own env defaults (2 vCPU / 2 GiB / 512 pids). The
   per-agent 50 GiB JuiceFS quota is the only limit that actually applies.
   Decide: pass `resources` into the sandbox spec, or remove the field.
3. **Harden the sandbox volume against a remount.** The runner detects a
   dead FUSE session by polling its volume roots, and the attach probe is a
   second guard. Replace both with one rule: every runner interaction with
   the volume goes through one helper, and `ENOTCONN` from that helper means
   the volume is gone. The reaction is the same as today (remove the
   sandboxes, restart the runner), but it fires on the failing call instead
   of up to 10 s later, and no new interaction can forget the check. Then
   drop the poll. The real fix stays open: mount the volume where the
   containers can re-resolve it (the entrypoint TODO), so a remount stops
   invalidating every container by construction.
4. **Set an org storage budget for shared agent workspaces.** The 50 GiB
   quota is per agent, and agent count is unbounded, so one org can fill the
   object store. Decide the budget and where it is enforced.
5. **Decide whether an archived thread can move to another agent.** Today a
   live thread moves with its transcript; an archived one has no such path.
6. **Decide machine identity after an OS reinstall.** A changed hardware
   fingerprint matches no row, so the machine registers as new and its old
   chats go dark. Candidates: derive the fingerprint from the firmware/board
   UUID, or give the user an explicit takeover on the machines page.
7. **Measure the rest of the long-thread path.** Composer typing is fixed.
   Initial load and scroll of the 3000-event dev thread were not measured.
8. **Cover the review gaps in the next loop:** Windows-only engine paths
   (compile-checked, never run), the desktop updater flow on a real install,
   and the integration connectors.

## Latest decisions

- **Full review applied: trust boundaries, one home per layer, exact
  machine files, desktop stores (2026-11-03).** A six-lane review (server
  runtime, platform/hub, services, desktop, Rust, cross-cutting) found two
  trust-boundary bugs and a set of structural ones; this entry records the
  rules the fixes set.
  - *Agent workspace files never follow sandbox symlinks.* Server reads and
    writes under an agent workspace go through `agents/workspace-fs.ts`:
    segment `lstat`, `O_NOFOLLOW|O_NONBLOCK`, a regular-file check on the
    opened file, real-path containment, byte caps (config 128 KiB with a
    marker). The sandbox writes that volume, so a planted link must never
    resolve in the server's namespace.
  - *Machine file ops are exact.* The server's machine file adapter reads
    through `fs.read_raw_v1` (exact bytes, 8 MiB cap, `too_large` instead of
    a cut) and `fs.stat_v1`, never the model's paged, text-only `read_file`,
    so a read-modify-write edit cannot write a large file back truncated. An
    engine without the ops fails file access as `not_supported`.
  - *Runs and turns.* Spawn, send and routine runs start through
    `startThreadRun`, which refuses a deleting or inactive agent and a
    requester who lost access; a routine runs only while its creator can use
    the agent (a scheduled occurrence fails at once with a notice, a manual
    run answers 403). A turn's idempotency check runs before the agent
    binding and covers `agent_id`. `send_message` dedupe is per user and
    chat of origin. Grant roles are `owner|user`; a row with another role
    grants nothing.
  - *Outbound URLs.* `integrations/ip-guard.ts` is the one address
    classifier (hex IPv4-mapped IPv6, CGNAT, this-network, multicast
    included); the user MCP guard and the `web_fetch`/`map` guard share it.
    Integrations share one `fetchTimeout`, `readBodyCapped` and
    `requestJson`.
  - *Layers, enforced.* `arch-layers.test.ts` knows every top-level folder;
    no layer imports the composition root; the DAL imports nothing above
    it; durable tables are read only through `storage/postgres/queries.ts`;
    platform-table SQL outside the DAL is a shrinking allowlist. `src/http`
    moved under `platform/http`, `platform/integrations` into
    `src/integrations`. The runtime is built from `RuntimeDeps`
    (`platform/stores.ts`, once per process) and its turn placement lives in
    `harness/turn-backend.ts`. Migration 0105 owns `chat_conversations`;
    `PlatformContext.start` is the one bootstrap. Worker IPC has one turn
    input, a ref space per direction, error codes kept across the fork,
    timed-out requests and the config passed as JSON; the core turn flow is
    tested in both placements.
  - *One DAL per lane.* `agents/store/` is the agents lane's data access
    (bindings, chunks, delivery, events, occurrences, routines, run-finish,
    stale-runs, tree, workspace-turns beside the store modules); the agents
    services keep only logic, and the scheduler's claim transaction passes
    its client down. `arch-layers.test.ts` counts `agents/store/**` as DAL
    and fails on any platform-table SQL outside the DAL: the allowlist is
    gone.
  - *Migrations.* An applied migration is never edited unless
    `migrations/amended.json` lists the edit with the hashes it replaces;
    the runner adopts the current hash for those and warns on any other
    drift, and a test holds every migration shipped with the last client
    tag to its released bytes. 0022 (comment) and 0092 (fresh-schema guard)
    are listed.
  - *Agent store.* `AgentStore` keeps the agent rows and the access check
    (`AgentCatalog`) and exposes `grants`, `threads`, `tree`, `runs`,
    `notices` and `lifecycle` from `agents/store/`; callers name the
    sub-store, and its `ChatStore` is injected. Recovery, the approval gate
    and the thread-history tools read through the platform stores, so the
    SQL allowlist names only the agents lane. An agent-list push burst costs
    three reads for any number of members (`AgentGrants.visibleAgentIds`).
  - *Push.* The NOTIFY channels are one typed parser table, per-key pushes
    share `KeyedChain`, and `DEFERRED_UNTIL_SYNC` classifies every frame
    tag. A read that moves nothing notifies nothing, nor does a no-op agents
    UPDATE (0106). `member_profile` carries the member's own account on
    every workspace push and on each role, name, avatar or onboarding change
    (0107), so a promoted member gets the admin UI live.
  - *Admin configuration stays a read.* The settings sections' lists
    (users, teams, MCP servers, registry items, integrations, gateway routes
    and providers, SSO) are admin editing surfaces read on open, like the
    ClickHouse analytics: the admin who edits them is the one viewing them.
    Anything a member sees change live is pushed.
  - *Engine.* The dead machine surface (`artifact.prefetch_v1`,
    `context.prepare_v1`, `MachineContext`, `edit_file`) is deleted; the CLI
    `chat` streams from the gateway itself; registry install/uninstall take
    `project_dir` per call; config-dir writes follow the read grant;
    `rpc.schema.json` declares every method and tests hold the dispatch
    table and the webview allowlist to it; one lazy, owner-only trace, off
    by default; plain-http pairing needs a loopback host or
    `GUILD_ALLOW_INSECURE_PAIRING=1`.
  - *Desktop.* `foldEvent` is the one event-to-block rule for the full and
    live paths, with keys `<seq>:<n>`. Chat rows, status, trees, projects,
    agents, gateway keys and MCP tool counts are `createStore` stores the
    socket writes; ThreadView only assembles its parts. A frame before its
    seed wins; a failed seed is an error with retry. `canonicalRoute` is the
    one address normaliser; the skills route carries the shown file and the
    catalog query; text filters replace the history entry, discrete picks
    push. A wake resyncs only a dead or stale link. Engine replies reach
    the webview as an `engine-rpc` event (no `rpc_poll`), with a per-request
    deadline set in `rpc_submit`; `rpcCall` is typed by method
    (`WebviewRpcResults`). The OIDC callback fragment is consumed in the
    route layer, and `writeAddress` in `route.ts` is the only history write.
  - *Gate.* `check.mjs` compares property shapes by name (array elements,
    inline objects, maps) and fails on undeclared types or refs; the release
    script refuses a dirty tree or a moved tag and runs it before building.
    `check.sh` gains `fmt` and `biome` (`biome ci`: the TypeScript and
    JavaScript trees are formatted and linted by `biome.json`; captured
    fixtures and JSON data are left as written) and typechecks `packages/ui`;
    the desktop targets ES2022 like the server; coherence gates
    `milestone_tags`. Tests share one disposable-database factory under
    feature names. A test that something does not happen waits on a
    barrier, never a fixed delay: `NotifyHub.barrier()`,
    `FeedForwarder.idle()` and a socket `pingBarrier()` (ping, then its
    pong) for the feed, `idle()` on the trace and usage sinks, fake timers
    for windows and backoffs.

- **A first send opens its thread once the server holds it; the keyboard
  never pans the shell (2026-11-02).** The scratch composer stays frozen
  (text, spinner) through create, uploads and submit, and the route moves
  only after the submit is accepted, onto a seeded thread already working.
  A seeded target no longer counts as navigating (no progress bar, no
  disabled composer). A pending send carries its message id and retires
  only on a state that speaks for it (generating, its echo, or a resync
  view), so a state from before the accept cannot flip the composer back to
  idle. On iOS the viewport pin undoes the keyboard pan after taking the
  visible height: the header stays and only the message list shrinks.

- **A push waits for a read, not for an absent socket (2026-11-02).** The
  notifier no longer skips a push because some member socket is open. A
  finished turn records the chat's last event seq, waits four seconds
  (`READ_GRACE_MS`), and pushes unless the owner's read marker reached it.
  Clients mark a chat read only while it is open and visible, so the read
  marker is the presence signal, per chat.

- **Layers, one home per helper (2026-11-02).** The review's structural
  findings, applied:
  - *Server layers.* The composition root is `src/composition.ts`, above
    every layer; `platform/` no longer constructs the services it hands out.
    The agent routes live in `platform/http/agents.ts`. `arch-layers.test.ts`
    checks every service folder (agents, chats, execpolicy, harness, hub,
    integrations, machines, push, sandbox, worker) and bans all of them
    from the DAL; `AgentThreadType` lives in `platform/domain`.
  - *One home.* The runtime owns the process's one `AgentStore`. Every
    transaction goes through `withTransaction`. `utcText(column)` in
    `platform/time.ts` is the one RFC 3339 timestamp expression;
    `canonicalJson` and `sortedJson` live in `platform/domain/json.ts`.
    `platform/registry-publish.ts` is the one registry publish (route,
    skills editor, `push_skill`). Common HTTP errors use the `ApiError`
    factories. The dead `Hub` interface is gone.
  - *Desktop.* `lib/store.ts` `createStore` is the store primitive; every
    store it makes, the settings cache and the agent store register with
    `lib/session-reset.ts`, and sign-out calls `resetSessionState()` once.
    The member socket's handlers read the current render's callbacks
    through a ref. The agents and skills views use the wire types. `CHAT_ROOT`
    and `SURFACE_BASE` name the root route patches. `lib/timeout.ts` is the
    one timeout race. `@guild/ui/components/empty-state` is the one empty
    state.
  - *Tests.* One `createObjectStoreStack` replaces the M6/M7 harness copies;
    `test/support/wait.ts` is the one `waitFor`.
  - *Comments* no longer narrate the Rust port or plan steps; references
    that state a live wire contract with the engine stay.

- **The engine no longer carries a turn-driving stack (2026-11-02).** Agent
  turns run in the TS server's durable harness, so the engine's own
  `agent.start` / `agent.approve` / `agent.policy.*` surface, the approval
  plumbing behind it (`agent_session.rs` with the approval policy types,
  `agent_start.rs`), the engine-side MCP client (`mcp.rs`, the `rmcp`
  dependency), the `models.list` /
  `machine.info` verbs, `daemon::spawn_detached`, the cloud calls only
  that path made, and the artifact prefetch paths had no live caller:
  neither the webview nor the CLI sent those methods. They are deleted.
  What stays is what something calls: `chat.send` (the CLI's `chat` verb,
  its stream mapping now in `chat_stream.rs`; the JoinSet that owns its
  streams is renamed `Shared.streams`), auth/session/workspace verbs,
  `machine.identify`, `registry.*`, `fs.*`, and the socket lifecycle verbs.
  `attach()` drops the binary path it ignored.

- **Second review pass: isolation, delivery and lifecycle fixes
  (2026-11-02).** A full architecture review found bugs the earlier pass
  missed; this entry records the rules the fixes set.
  - *Isolation.* An agent's conversation search and read (the tools and
    `GET /agents/:id/search`) filter by the calling user: sharing an agent
    never shares its threads. A spawn target resolves among the agents the
    requester can see (`AgentStore.findVisible`); a name two visible agents
    share picks the requester's own or answers `ambiguous_target`.
    `reconcileMachine` settles only the reconnecting machine's calls.
  - *Delivery.* A restored LISTEN connection calls each subscriber's
    reconnect hook, and the feed re-pushes every connected user's workspace,
    agent and skill state and re-captures each shown chat. The
    `guild_chat_status` NOTIFY rides the UPDATE that changes the flag, and an
    arriving turn reserves `generating` under the row lock. The SSE thread
    stream is deleted: the member socket is the only push path.
  - *Lifecycle.* A routine claim carries `claimed_at` (migration 0104); only
    a claim older than the two-minute lease with no run is reclaimed. The
    stale-run sweep skips chats holding durable work. Archiving or deleting
    an agent cancels its runs and stops their chats; restore needs an
    archived or deleting agent. An integration save writes secrets and
    config in one transaction.
  - *Trust boundaries.* The engine's remote `fs_list` refuses non-WSL UNC
    paths (`fs_bridge::check_unc_browse`, shared with the desktop browser);
    a skill bundle on another origin is fetched without the bearer. The
    user MCP SSRF guard runs on every runtime connect. The web CSP is
    `script-src 'self'`; the boot scripts load from `/boot.js`.
  - *Errors.* Every 403 names its reason (`ApiError.forbidden(message)`,
    `adminRequired()`); the phantom `owner` org role is gone. An invalid
    JSON-RPC request with an id gets an `INVALID_REQUEST` response; an
    unknown method answers `METHOD_NOT_FOUND`; engine locks are
    poison-tolerant (`sync::LockExt`).
  - *Desktop.* The agents views use the wire types (the never-sent unread
    fields are gone). The member socket redials with exponential backoff and
    full jitter (1 s to 30 s). The older-page loader and the SSO status check
    ride `lib/api/request`. Skill detail re-reads on a pushed catalog change
    and tells a 404 from an unreachable server.
  - *Tests.* The agents harness skips only on connection-level errors, so a
    failing migration fails the suite.

- **Delete closes the subtree; a deleting agent is read-only; list pushes
  coalesce (2026-11-02).** Deleting a chat cancels, closes and deletes its
  agent-thread subtree in one transaction, and the user whose run spawned a
  child chat may delete it directly (it takes its own subtree, never the
  parent). Turns and bindings to an agent in `deleting` answer 409
  `agent_deleting`; its threads stay listed read-only through the grace
  period, and restoring the agent lifts it. Agent-list and skill-catalog
  pushes send one frame per write burst (50 ms quiet window, 250 ms at
  most).

- **A view frame goes only where the chat is shown (2026-11-02).** The final
  browser pass caught a socket on /activity receiving 1.9 MB of another
  tab's compaction. Each socket records the chat its latest `sync` named;
  `thread_state`, `thread_events`, `live_frame` and `context_usage` go only
  to the owner's sockets showing that chat, while sidebar facts
  (`chat_status`, chat rows, trees) still reach every socket. A socket that
  never syncs (the engine's turn stream) keeps receiving everything. A
  changed chat republishes once per quiet 100 ms tick (300 ms at most),
  and the forced compaction republish rides the same tick, so one
  `/compact` sends at most two views. `AgentRun` carries optional
  `call_count`/`tool_count` from the trace spans. The composer names its
  agent from pushed state, and a member's address for an admin-only
  settings section is replaced by Account.

- **A push carries only what changed, and every display fact has one
  (2026-11-02).** Browser verification of the push work found a socket that
  re-sent the whole workspace bracket on every chat flip (about 90 KB per
  turn) and three facts still outside the socket. Workspace pushes are now
  a per-socket diff (`hub/sent-frames.ts`): a list that keeps its rows and
  order sends one-row `chat_row` frames to clients that connect with
  `features=chat_row`, older clients keep the full `thread_list`, and
  whole-value agent and skill frames are skipped when a user's filtered
  value did not change. Context usage is a pushed `context_usage` frame
  (`ModelOption.context_window` rides `model_list`); the meter no longer
  reads `GET /context`. A compaction task write sends `guild_compaction`
  and the feed republishes that chat's view, so a compaction that writes no
  summary, fails or is cancelled clears its line live; the `/compact`
  answer carries a `seq` so the client can tell whether a lowered state
  already covered it. A thread is named by its chat's title, and a rename
  re-pushes every header and subtree that names it (migration 0103). A chat
  the reader does not own is read-only, and `ChatTree.own` says so. An
  unknown settings, agents or skills address is replaced by the page shown.
  The run page re-reads its trace once when the pushed run finishes: the
  spans are a ClickHouse query, not socket state.

- **Agent, skill and operational state is pushed (2026-11-02).** The last
  one-shot fetches and polls for state that changes while the app is open
  are gone. Migration 0101 adds NOTIFY triggers on the agent, run, routine,
  thread, grant, team-member, chat-flag and skill tables: about thirty
  write sites move that state, and a trigger cannot be forgotten by a new
  one. `hub/agent-state.ts` turns each notify into a whole-value frame,
  scoped by the same visibility predicate the agent list uses:
  `agent_list`, `agent_run`, `agent_routines`, `agent_threads`,
  `skill_catalog`, and `chat_tree` (the child-thread header, sent inside the
  sync bracket; the client no longer fetches `GET /tree`). `model_list` is
  pushed on connect and on every gateway route write. `thread_state` carries
  `compacting`, read from the durable compaction tasks, so a compaction that
  writes no summary or fails clears its line live; the 1 s compaction poll
  is gone. `workspace_identity` names the served web bundle, which replaces
  the 60 s bundle poll: a browser tab reloads into a new bundle when idle,
  and a desktop shell never does. HTTP still seeds first paint of an
  agent's runs, threads and routines, and the windowed ClickHouse analytics
  (trace spans, Calls and Chats) stay reads with a Refresh: they are
  queries over a time window, not state. `org_event` now has a subscriber
  (the skills activity feed). The machine-presence stubs and the "Taken
  over" banner are gone: a browser socket carries no machine id, so
  `displaced` there only means the server shut down.

- **Review fixes: access, lifecycle and gates (2026-11-02).** A full review
  of the tree found authorization holes, lifecycle bugs and convention
  drift; this entry records the rules the fixes set.
  - *Chat access.* Admins may read a member's chat; every write (rename,
    archive, delete, project, approval mode, turns, appends, approval
    decisions, stop, compact, steer, attachments) is owner-only through
    `getOwnChat`, and a deleted chat refuses writes. The sync bracket checks
    access before it sends the subagent tree. An approval call settles once:
    the first decision wins under the chat row lock.
  - *Trust boundaries.* Push endpoints must be https on a known push-service
    host. `x-guild-*` trace headers count only on the internal key. An
    integration logo renders as an image, never as markup; the desktop CSP
    has no `'unsafe-inline'` script source; `rpc_submit` forwards only the
    engine methods the webview calls, and app commands are opt-in. The
    engine no longer serves `fs_read`.
  - *One shape per concern.* `/api/v1` errors are always the JSON envelope;
    only the OpenAI/Anthropic gateway keeps wire-shaped errors. The desktop
    has one REST client (`lib/api/request.ts`, one `ApiError`, one 401
    policy). Stores use one `withTransaction`; routes share one admin gate.
    `submitTurn` lives in `chats/`, the gateway pipeline in
    `platform/llm-gateway.ts`, usage SQL in `store/usage.ts`.
  - *Desktop state.* The visible thread is one store (`thread-view-store`)
    read through `useSyncExternalStore`; generating/unread live only in the
    per-chat status map, and `chat_status` moves every chat but the open one
    without retiring a pending send. A normalising route rewrite replaces
    its history entry. `HAS_SHELL`/`HAS_ENGINE` replace `IS_TAURI`. The
    Tauri shell holds no member socket of its own.
  - *Server runtime.* Project instructions persist on
    `chat_conversations.project_instructions`, so a resumed run keeps them.
    Startup attaches only chats with pending work. The feed keeps per-chat
    state only while the owner has a socket and logs every dropped push.
    Spawn checks the child limit under the parent row lock. Turns route
    through a `TurnBackend`; "supervisor" names only the reopen loop.
  - *Engine.* Each daemon host cycle opens its own link spawn feed, so a
    reclaimed host relinks. Reconnects back off exponentially with full
    jitter (1 s to 60 s). The JSON-RPC loop never awaits a handler in its
    read loop, and a lagging subscriber gets `rpc.lagged`. A turn stream
    ends only on its own terminal frame, auth loss or socket failure.
    guild-core is the local tool executor only.
  - *Gates.* `scripts/check.sh` type-checks the server, desktop and wire.
    The coherence `files`/`loc` counters are reported, not gated, and leave
    tests out. `protocol/check.mjs` holds the schemas compatible with the
    newest `client-v*` tag and checks TS scalar types.

- **A finished run reaches the phone (2026-11-01).** The socket cannot carry a
  result to a closed app, so the server now has a second transport beside it,
  not a second event system: `run_end` asks the push lane, which asks presence
  (a live member socket means the frame is enough) and then sends one Web Push
  per device with a per-thread topic, so a thread never piles up notifications.
  Devices live in `push_subscriptions` (migration 0100), keyed by a client
  device id; a 404/410 from the push service deletes the row instead of
  retrying it forever. VAPID keys are minted on first use and kept in
  `server_kv`, so a redeploy keeps the identity and existing subscriptions
  keep working. The payload names the thread and how the run ended — never the
  answer: the app syncs on open, and a push is only a hint. Settings →
  Notifications owns the per-device switch; iOS Safari reads as "add to Home
  Screen first" because that is the only place Web Push works there. The floor
  rises for the store, the sender, the notifier, the routes, the service
  worker and the settings pane.

- **The open chat's turn state is derived, not stored (2026-10-31).** `busy`
  was a `useState` with eight writers across three hooks: two of them were
  the server's own `generating` flag, four were "my send died", two were
  navigation resets, and every reader had to add `busy || openGenerating`
  back together. That is why a stale `true` could outlive a turn by 51
  minutes: nothing owned the value. Now there is one stored input —
  `pendingSend`, the chat this client sent to whose own frame has not
  arrived — and `busy = busyFrom(generating, pendingSend, openChatId)`
  (`views/thread/status.ts`). The pending send retires when the server
  speaks for that chat (`pendingAfterFrame`: a thread-state, a chat-status,
  or a failed submit). Consequences: the reconnect no longer clears a flag
  it did not set, navigation has nothing to reset, `busyAfterThreadPush` and
  the navigation machine's `clearBusy` are gone, and a swap cannot leak one
  chat's turn onto another. The floor rises by 29 LOC for the derivation and
  the sequence tests.

- **Telemetry is the workspace's decision, and the socket explains a hang
  (2026-10-31).** A user reported the app "hanging": the run finished in 15 s
  and the answer was stored, but his client kept the turn "generating" for
  51 minutes and his next message went out as a queued send. The server was
  healthy; the client missed the turn's end. Two things changed. The Faro
  switch is no longer a per-device toggle in Settings → About: it is
  `telemetry_enabled` in `org_kv`, **on when absent**, admin-only
  (`Settings → General`, `PUT /api/v1/org/telemetry`), and it rides the
  `workspace_identity` frame so every client starts or stops collecting
  live — a hang on one user's machine is only diagnosable if that machine
  reports by default. And the client now traces the sequence that explains
  such a hang: `socket.connect_start/open/close/connect_failed/watchdog_close`,
  `socket.sync_sent`, `thread.state` (applied or stale, generating, open,
  in-sync), `thread.list`, `thread.sync`, `socket.error_frame`, and every
  `busy.set` with the name of the writer that set it. The trace is bounded
  per event name and carries no message text or thread content. The floor
  rises for the switch, the frame field and the trace.

- **A thread always gets a name (2026-10-30).** The title call ran with a
  256-token cap, and a reasoning route can spend that whole budget thinking
  before it writes a word: the reply arrived empty with `finish_reason:
  length`, and the thread stayed "New thread" with no error logged. The cap
  is now 1024, and an empty or unusable reply falls back to the head of the
  user's first message, so a thread is named even when the model is not.

- **A chat message keeps its line breaks (2026-10-29).** Markdown in the
  thread, the compaction card, tool text and the agent message view now runs
  with `remark-breaks` (`CHAT_MD_PLUGINS` in `views/markdown.tsx`). CommonMark
  folds a single newline into a space, so a routine message written as plain
  `•` bullet lines arrived as one paragraph. A message is prose on a screen,
  not a document: its lines stay lines. Skill file previews keep plain GFM
  because they render a document. The floor rises by 17 LOC for the plugin
  set and its test.

- **The mobile client is an engine-less client (2026-10-28).** iOS runs no
  engine, no tools, and no machine link: it bundles its own UI and uses the
  same HTTP API and member socket as web mode. The first stage is foreground
  only — restore the session, reconnect the socket, run the normal sync
  bracket. Push comes later, and push on iOS means APNs and nothing else, so
  the server will gain a second transport beside the socket with one decision
  point, a device registry, and per-thread coalescing. Two consequences land
  before any mobile code: `IS_TAURI` must split into "the shell exists" and
  "a local engine exists", and iOS forces a TLS endpoint and a Mac build
  host. A remote UI bundle stays rejected — it moves the trust boundary and
  breaks 2.5.2/4.2. Research and the App Store rule table are in
  `docs/clients.md` §8.

- **An agent file rides its message to the client (2026-10-28).** `send_file`
  wrote the attachment row and bound it to the assistant event, but no read
  path ever used that binding: the client showed the model's "the file is
  attached" and no file. The terminal assistant message now carries the
  turn's pending agent files as `attachments` chips — the same shape a user
  message uses. The transcript projection reads the pending rows before the
  row is appended, the wire event gains the optional field (schema, Rust,
  TS), and the desktop stamps the chips onto the message's last text block.
  The event-id binding stays: it is what a child result reads to hand the
  file to its parent.

- **A sanitizer cleans keys as well as values (2026-10-28).** `jsonbText`
  and `recordJsonText` rebuilt their input with a JSON replacer, which never
  visits a key. A property name with U+0000 or a lone surrogate reached
  `jsonb` and failed the write. Both now rebuild every object through one
  cleaner, so a key and a value take the same path. `encodeValue` is
  lossless: the sandbox wire no longer replaces U+0000 in a call argument,
  because the record encoder cleans at the durable boundary. The turn
  command store compares a retry against the sanitized form, so a NUL no
  longer turns a valid retry into `command_id_conflict`.

- **A trace delta keeps the leaf's fields (2026-10-28).** A request row
  stores only the new messages. The read path now takes every non-message
  field (`tools`, `model`, the sampling settings) from the leaf, not from
  the root, so a change to them survives the rebuild. A delta longer than
  the body cap falls back to the capped full body, so a chain never holds
  cut JSON.

- **A request schema lists in `required` only what the reader needs
  (2026-10-28).** `Sync.chat_id` and `ToolResult.meta` are optional: the
  server reads an absent field as null. The fixtures still show the form
  the current writers send.

- **Older clients must keep working across core releases (2026-10-28).**
  The server and the desktop client release on different schedules, and a
  mobile client will release less often than either. A core release must
  therefore keep an installed client working. New fields are additive. A
  field or a variant is never renamed or removed without a version step. A
  reader ignores what it does not know instead of failing the frame. The
  schemas and the fixtures are the record of that promise, and
  `protocol/check.mjs` enforces it against the newest `client-v*` tag.

- **One chat row, one builder (2026-10-28).** `Chat` is now the list row and
  the body of every chat read and write: `type`, `archived` and `deleted` are
  required. The single-chat responses carried a reduced row, because they
  read one `ChatRow` and that row has no `working`, `blocked` or
  `last_activity_at`. That split cost a second shape and a hardcoded
  `unread: false`. It is gone: create, set-project, patch and delete read the
  list row back through `ChatStore.getChatListRow` and return it. The two row
  builders, `chatWire` in `platform/http/chats.ts` and `chatRow` in
  `hub/workspace.ts`, are one function in `chats/chat-wire.ts`. The desktop
  `ChatSummary` is the wire `Chat`, not an extension of it. The change only
  adds keys on the wire, so a running client keeps working; against the
  schema it is a contract change, because three properties join a closed
  object's `required` list.

- **`Json` is only for a value the protocol does not fix (2026-10-28).**
  Every frame payload that has a fixed shape now has a `$def` and a typed
  field. `thread_list.chats`, `archived_thread_list.chats`,
  `thread_state.events`, `thread_events.events`, `subagent_tree.nodes` and
  `org_event.event` carried `serde_json::Value` and a bare `Json` on the
  TypeScript side, so the contract promised nothing about them and the
  desktop cast each one. `ThreadEventRow`, `SubagentNode` and `EventRow` now
  live in `rest.schema.json` with Rust and TypeScript counterparts, and the
  socket frames reference them. The Rust frame envelope keeps `Value` for
  these rows on purpose: a daemon that does not know a new event type must
  still parse the frame it ignores. `Json` stays for tool arguments, an org
  event payload, an RPC parameter and a trigger config. The checker now
  compares every named object and union, not only the fixture roots, so
  `StreamEvent` is checked without a fixture of its own. The desktop
  `ChatSummary` no longer widens `title` to a required field: the wire omits
  it when the chat has none. The builders return the type they build:
  `threadEventObject`, `threadEventRowObject` and `projectJson` no longer
  return a bare record. The desktop's `onFrame` takes `StreamEvent`, not a
  loose frame bag; that removed a dead read, `tool_completed` has no
  `executor` field.

- **The sandbox wire is not part of the protocol contract (2026-10-28).**
  The sandbox is an implementation detail of the server: both ends ship in
  this repository, and the whole runner is a migration target. Its schema and
  its two fixtures are deleted. The frames and the value encoding stay in
  `apps/server/src/sandbox/protocol.ts`, beside the code that owns them.
  `protocol/` holds only the wires that cross a boundary we do not own: the
  member socket, the REST data-transfer types and the JSON-RPC envelope. The
  checker now registers each schema by `$id`, so a frame can reference a row
  type that another schema owns instead of copying it. `project_list`,
  `machine_list` and `tool_call_done.call` use the REST `Project`,
  `MachineInfo` and `ToolCall`. A request-only type follows the reader, not
  the writer: `CreateProjectRequest.name` may be absent, because Rust reads a
  missing `Option` as `None` while it always writes one as `null`.

- **The wire check reads the TypeScript declarations (2026-10-28).**
  `protocol/check.mjs` now parses `packages/wire/src/*.ts` with the
  TypeScript compiler and compares each fixture root against its schema:
  property names, and required versus optional. Before, it only checked that
  a declaration with the right name existed, so a renamed or weakened field
  on the TypeScript side passed. The Rust fixture round trip now compares
  the serialized JSON with the fixture frame for every root, not only the
  types without `PartialEq`; an unknown field in a fixture can no longer be
  dropped silently. Two fields the schema already declared now reach the
  wire: `approval_request.judge` (the renderer and the legacy normalizer
  dropped it) and `assistant_message.usage` (always emitted, empty when
  absent). `recordJsonText` and `jsonbText` live together in
  `platform/domain/text.ts`, so the U+0000 rule and the lone-surrogate rule
  are stated once.

- **The sandbox runner is a migration target, not the end state
  (2026-10-28).** The server-side sandbox is our own `sandbox-runner` (the
  only holder of the Docker socket) plus an in-sandbox agent
  (`agent.js`/`serve.js`/`protocol.js`). It works, but we own the daemon and
  the frame protocol. The direction is an off-the-shelf sandbox platform;
  NVIDIA OpenShell is the leading candidate. The platform supplies the
  gateway, the supervisor and the policy. We keep one server-side adapter
  from `ExecutionEnv` to the platform API. What we want from a platform:
  filesystem, process and network policy, credential brokering, and drivers
  for Kubernetes and GPU. What it does not give for free: handles, watchers,
  streamed output and cancel; the adapter must map them. The in-sandbox code
  moves from us to the vendor, it does not disappear. No change is made now:
  the current runner stays until the adapter reaches parity with
  `ExecutionEnv`.

- **The protocol branch merges with develop (2026-10-28).** `develop` brought
  the record-text sanitizer (`platform/domain/text.ts`) and the attachment
  author fix. Two merge points needed a decision. `jsonbText` now builds on
  `sanitizeText`, so one function owns the U+0000 rule and `jsonbText` owns
  only the JSON-text part. The sandbox image copies `text.js` to the path
  `sandbox/protocol.js` imports; the agent would not start without it. The
  new `text.ts` gets a `storable-text` concept in the model, and the floor is
  raised by the two files and 153 lines `develop` adds.

- **Every wire type has a schema, a fixture and a TypeScript declaration
  (2026-10-28).** The hand-written contract replaced the generator with
  `protocol/*.schema.json`, but it covered only the types that had a fixture:
  nineteen shapes the old bindings described had no schema entry — `Chat`,
  `UserInfo`, the login and pairing shapes, `MachineInfo`, the chat and
  project request bodies, `ChatCompletionRequest`, `MachineContext`, and the
  JSON-RPC envelope. Those rows were `Record<string, unknown>` on the server
  and private copies on the client (`ChatSummary`, `UserInfo`), so nothing
  checked them against Rust. All nineteen are now schema definitions with
  fixtures: `rest.schema.json` for the HTTP DTOs, `socket.schema.json` for
  `MachineContext`, and a new `rpc.schema.json` for the stdio envelope. The
  Rust suite round-trips each fixture back to the same JSON (a second helper
  for the types without `PartialEq`), and `check.mjs` now fails when a
  fixture root has no `@guild/wire` declaration. Two Rust structs had drifted
  from what the server sends: `Chat` lacked `working`, `blocked` and
  `last_activity_at`, and `UserInfo` lacked `onboarded`. Both now carry them,
  and `chatRow`, `machineInfo` and `userInfo` return the shared types. The
  client's private `UserInfo` and its duplicate `ChatSummary` fields are
  gone: `ChatSummary` extends `Chat`. The coherence floor rose by 2 files and
  394 loc; the duplicated declarations paid about 20 lines of it, and the
  rest is the contract itself.
- **Records are JSON text; queries parse them in code (2026-10-28).** A
  `codemode` tool result carried an `.xlsx` dumped as text, so the record
  contained a `\u0000` escape. `ThreadStore.contextUsage` cast
  `entries.record::jsonb`, and JSONB rejects U+0000: the context meter
  answered 500 with `22P05` on that thread. The storage contract already
  says record columns are text, not JSONB. The fields queries filter on are
  now real columns — `entries.kind` and `tasks.outcome_status` — written
  from the same record in the same statement. The read paths parse the one
  row in code. U+0000 cannot enter a record: the sandbox wire and the
  durable encoder replace it with U+FFFD. A source test keeps
  `record::jsonb` out of the server.

- **A user upload records its author and stays pending (2026-10-28).**
  Migration `0088` set `attachments.event_id`, `author_kind` and
  `author_id` to `NOT NULL` once the backfill left no gaps. The user upload
  path inserts none of the three, so every upload answered 500 with
  `23502` on any database that reached that state (prod did; dev did not,
  because its table was empty at migration time). Only an agent file gets an
  `event_id`, bound when the turn's assistant event lands. A user upload is
  pending until a message references it. Migration `0099` drops `NOT NULL`
  on `event_id` again, backfills old authors from the chat owner, and keeps
  `author_kind`/`author_id` required; `AttachmentStore.create` writes
  `author_kind='user'` and the uploader's id.

- **The prompt names the Guild user of the thread (2026-10-28).** A routine
  reported "no new Jira tasks" while five were assigned to the user. The
  prompt carried no identity: the model learned who it talks to from
  whatever a tool answered, and Jira's `currentUser()` answers for the API
  token's account — here another person's. The guild prompt section now
  appends one line built from the chat owner:
  `<current_user name="…" email="…" />`. `ChatStore.ownerOf` joins `users`
  and returns the owner's account fields (email, display name, role); the
  skills runtime deps read the role from it instead of a second query.
  Identity reaches the prompt only — usage and trace rows keep their
  `user_id`.
- **The wire is a schema and fixtures, not a generator (2026-10-28).** The
  TypeScript frame types came from `ts-rs`: `cargo test -p protocol --features
  ts` wrote 72 `.ts` files into `crates/protocol/bindings`, a perl pass
  rewrote their imports, an in-place `tsc` emitted `.js`/`.d.ts`, and
  `scripts/check-bindings.sh` failed on drift. Fourteen import sites used it,
  all `import type` — no runtime value ever crossed. The pipeline is gone.
  The contract now lives in `protocol/`: `socket.schema.json` for the member
  socket and `rest.schema.json` for the HTTP DTOs, each derived field by field
  from `crates/protocol/src/`. The types are hand-written on both sides —
  `packages/wire` (`@guild/wire`) for TypeScript, the Rust crates as before —
  and `protocol/fixtures/<schema>.<Root>.json` holds one example per variant.
  `protocol/check.mjs` validates every fixture against its schema and requires
  a fixture for every variant; `crates/protocol/tests/fixtures.rs`
  deserializes every one of them, so a schema that drifts from Rust fails the
  Rust suite. No Rust generates TypeScript in any form.
  - **Presence, not bytes.** The old golden test compared raw strings, so the
    server hand-assembled JSON to reproduce serde's key order and float text.
    The contract is presence: the same field is present or absent, and `null`
    means null. Key order and number text are not load-bearing, so the
    serializers are plain objects and `JSON.stringify`. The golden test parses
    both sides and compares normalized values. This removed about 290 lines.
  - **The cost.** `packages/wire` is 4 files where the generated tree was 72,
    and the coherence counters moved by +4 files and +24 loc, because the
    scanner already skipped generated files. Net against `develop` is down
    5 loc, and the +24 is the fixture test that makes the TypeScript side of
    the contract real.
  - **The same idea elsewhere.** `rustJsonText` re-implemented serde_json for
    HTTP responses — sorted keys, ryu floats, a marker that kept a `.0` tail.
    It served 61 call sites in 17 files and it is gone; those responses are
    `JSON.stringify` too. The sandbox `ClientFrame`/`AgentFrame` are
    `SandboxClientFrame`/`SandboxAgentFrame` so the name is not shared with
    the member socket.

Older decisions (before 2026-10-28): `docs/archive/decisions.md`.

## Future directions

- **Decide the skill scope: per-user installs or per-agent sets (open,
  2026-10-21).** Installs and pins are per user today, and a chat resolves
  them through its owner (`identity` in `apps/server/src/harness/skills.ts`),
  so two people who use the same shared org agent get two different skill
  sets and two different pins from it. The alternative mirrors the existing
  tool pattern: `agents.skills` (JSONB slug list) plus `agents.skills_mode`
  (`selected` | `all`), with personal agents defaulting to `all`. That
  costs a migration, the four call sites in `harness/skills.ts`, the agent
  create/update routes, the agent settings UI, and a new source for the
  machine-sync payload (the union of the skill sets of the agents a user
  can run). Kept per-user for now: pins are optional and installs follow
  the latest, so the wrong-scope damage is small. Revisit when a shared
  agent needs a fixed skill set for everyone.

- **Schema-first protocol types (protobuf or similar)** (2026-10-14):
  define the wire types once in a language-neutral IDL and generate both the
  Rust and TS types from it, instead of hand-writing them on each side.
  Removes the hand-written copies on each side. Precondition for picking the tool: it
  must preserve the fixture conformance gate and the 64-bit wire-field
  number handling.

- **Wire field renames (`chat_id` → `thread_id`) are still open.** The
  routes and client paths moved to threads in 0.5.47; the wire fields did
  not. Any rename is a client/server coupling decision, so it ships as one
  deliberate release.

- **A future review loop** (when a meaningful diff accumulates): start from a
  surface-coverage map rather than a full-diff audit — see
  `2026-09-24-loop-summary.md` (git history) for the per-surface pass counts
  and the process playbook (mixed reviewers; pi fixer/verifier; verifier
  rebuilds exploit chains against the real caller; env var gotcha:
  `GUILD_TEST_PG_URL` is a base URL without a db suffix).

- **Engine/product direction unchanged:** one agent loop, thin desktop
  backend, project-derived executor binding, durable turns on `pi-durable`. The
  review rounds tightened contracts (auth generations, executor identity
  validation, effect-claim tombstones) without changing the architecture.
