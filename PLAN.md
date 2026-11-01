# PLAN — current state and future directions

Guild is a self-hosted Codex/Cowork replacement: a TypeScript cloud
server, a Rust local engine with shared protocol/core crates, and a Tauri
desktop client. Product requirements live in `docs/PRD.md`, system contracts in
`docs/SRS.md`, deploy recipes in `docs/deploy-nuances.md`, client release
recipes in `docs/clients.md`. Repo conventions are in `AGENTS.md`.

This file tracks where the project stands and where it is going. The
decision log is the changelog: each entry says what changed and why, newest
first. Code comments describe only the present.

## Latest decisions

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
  schemas and the fixtures are the record of that promise. No gate enforces
  it yet; this entry is the rule a gate will enforce.

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

- **A read mark pushes the workspace lists (2026-10-27).** `markRead` wrote
  `chat_reads` and stopped there, so only the client that sent the mark hid
  its dot — the client did that optimistically. Every other open client of
  the user kept a stale `unread: true` until an unrelated workspace push.
  The write now fires `guild_workspace` like the other list-moving writes,
  so the sidebar lists repaint on both the socket read frame and
  `POST /threads/{id}/read`.

- **Integrations are plugins in a shop, and traits carry Guild-provided names
  (2026-10-27).** The catalog was one 979-line switch in
  `platform/integration-catalog.ts`: adding a connector meant editing the
  core, and the admin page listed bare slugs. Each integration is now a
  folder under `apps/server/src/integrations/<slug>/` holding
  `integration.ts` (manifest: title, publisher, summary, long description,
  docs URL, categories, traits, settings fields, tool declarations, the
  connection probe, the execute function), `execute.ts`, and `logo.svg`.
  `integrations/index.ts` is the only list, `loader.ts` validates every
  manifest at startup and reads the logo, and `platform/integration-catalog.ts`
  is a re-export shim. Grafana ships as the first new plugin:
  `query_metrics` (PromQL through a named Prometheus datasource),
  `query_logs` (LogQL through a named Loki datasource), `list_datasources`,
  `list_dashboards`, `get_dashboard`, `list_alerts`, and `api`. Every tool
  takes an optional `datasource` and the result names the datasource it
  used — a wrong region is a wrong answer.
  - **Trait tools.** A trait is a capability with one Guild-provided tool
    name, description, and schema (`integrations/traits.ts`): `web_search`
    and `web_fetch`. An integration declares which trait its tool
    implements; the first enabled integration in index order keeps the
    trait and the model sees one tool under the generic name. The
    provider's raw tool name rides the tool info (`raw`) for dispatch, so
    a shipped `searxng_web_search` call still resolves. Migration 0098
    rewrites agent allowlists from the slug-namespaced names to the trait
    names.
  - **The shop.** `GET /api/v1/admin/integrations` returns one `items`
    array — every plugin with its storefront metadata (title, summary,
    description, logo SVG, publisher, version, docs URL, categories,
    traits) and this org's install state (`configured`, `enabled`, `id`,
    `config`). The page is a card grid with search; a card opens the
    detail, which shows the description and offers "Add integration",
    then becomes the settings/secrets/curation form. Registry v2 manifests
    may carry `title`, `summary`, `logo`, `publisher`, and `docs_url`, so
    an installed plugin looks the same as a shipped one.
  - **The floor.** The change adds 19 files and 1045 lines (net of the
    966-line catalog deletion) and raises the coherence floor in the same
    commit; nothing removable was found inside the touched boxes.

- **A thread has a type, and archive and deletion are flags (2026-10-27).**
  The thread view read one `readonly` boolean for three different things, so
  an archived user thread showed "Subagent thread. Read-only", and the
  header menu hid the only Unarchive action. `agent_threads.kind` mixed the
  type with the default-thread role; migration 0097 splits it into
  `type ∈ user|subagent|routine` plus `is_default`, and adds
  `chats.deleted_at` next to `archived_at`. The tree endpoint returns
  `type`, `archived` and `deleted`; the sidebar list rows carry the same
  three. `threadFacts()` derives them from the lists and the tree, and
  `threadAccess()` reads the result: only a live, active user thread is
  writable. Archiving keeps the menu (Unarchive, Delete) and shows an
  Unarchive banner; deletion asks for confirmation, stops the subtree and
  drops the thread from every list while keeping its transcript.
  `DELETE /api/v1/threads/{id}` is the deletion route. Agents get
  `conversations_list`: the calling agent's own threads, filtered by type,
  archive and deletion state and parent, sorted by activity or creation
  time, with an opaque keyset cursor (`limit` 1–100). It is in
  `ALL_AGENT_TOOLS` and `DEFAULT_AGENT_TOOLS`.

- **The skill editor edits the whole bundle, and the spent thread importer
  is gone (2026-10-27).** The editor wrote `SKILL.md` and nothing else, so a
  skill with `references/` or `scripts/` could only be republished by a fork
  or the raw registry route; its own source endpoint already returned those
  files. The editor now shows the bundle as a file tree
  (`views/skills/skill-files.ts` + `FileTree.tsx`, shared with the detail
  page's Files section): pick a file, edit it, add or delete one, and the
  review step diffs every file, deletions included. `POST`/`PUT
  /api/v1/skills` accept `files: [{path, content}]` and refuse unsafe paths
  (`SKILL.md`, `manifest.json`, absolute, `..`, backslash). A published file
  the source endpoint cannot return as text (binary, or over the 256 KiB
  inline cap) blocks the save instead of being dropped by the round trip.
  The change costs 422 lines, so the floor is paid with the thread importer:
  the cutover it performed is done, its fixture was a captured snapshot of
  the old log, and `importer/durable.ts` — the chat ↔ conversation mapping
  the runtime and two test suites still use — moves to
  `chats/durable-mapping.ts`. The `import-threads` script goes with it.

- **Machines can be deauthorized, and the Approvals page is gone
  (2026-10-26).** Settings → Machines was read-only, so a machine that left
  the fleet stayed in the list forever, and the only "unpairing" was manual
  row surgery. `DELETE /api/v1/machines/{id}` now drops the row, unbinds the
  chats that ran on it (they fall back to the server executor), closes its
  live socket and revokes the session it paired with — `machines.session_hash`
  is recorded at connect (migration 0096), so the app cannot sign back in and
  re-register itself. A machine with bound projects refuses with the project
  names: their files live there, and re-homing them is the user's decision.
  In the same pass the Settings → Approvals page is deleted: it restated the
  composer's chat modes in a second vocabulary (`default/ask/allow/never` vs
  `ask/approve_for_me/full_access`) that could not express "deny all", its
  "Server default" label contradicted the server's own
  `SERVER_DEFAULT_POLICY`, and its per-tool JSON box duplicated the
  per-tool approval dropdowns on Integrations and could not even be saved
  while "Server default" was selected. The account policy stays readable by
  the API and the composer; nothing in the app writes it now.

- **A routine run reaches the user only through `send_message`
  (2026-10-26).** A routine's run thread is an isolated transcript, so a
  digest written there is invisible: the Assistant's morning digest ran,
  succeeded and reached nobody. The run's system instructions now carry a
  `<routine_run>` block that says the thread is private and the user is
  reached only through `send_message`; a run with nothing worth reporting
  sends nothing, and the transcript's final message is neither delivered nor
  worth tokens. A
  `send_message` call records its calling
  thread as the delivered thread's `origin_thread_id`. That thread's
  instructions name the run thread, so a reply can read the work behind the
  message with `conversation_read`, and the chat tree returns `origin` so
  the client renders a link to the run inside the delivered message body,
  above its timestamp. A routine run's transcript opens with the prompt
  that started it: the scheduler writes that row, because no client command
  exists to echo. The run thread is read-only in the UI and takes its title
  from the tree, so a link into it lands on a titled transcript instead of
  an unknown-thread state. Origin is provenance, not delegation:
  `parent_thread_id` keeps the subagent tree. The change is paid for by deleting 22 orphaned exports (dead UI
  components, API helpers and thread-event utilities) that no importer
  reached.

- **The quality gate is one script, and the slow checks are cheaper
  (2026-10-26).** `scripts/check.sh` runs the baseline checks concurrently,
  prints PASS/FAIL with per-check seconds, and exits 1 on any failure.
  `cargo nextest run --workspace` replaces
  `cargo test --workspace` (13 s vs 39 s, same 241 tests; per-test process
  isolation also removed the `machine_link` mock-socket failure). The TS
  server suite drops from 50 s to 20 s by raising vitest to 14 workers (the
  shared Postgres allows 500 connections) and by removing the ClickHouse
  auth failure that every test harness logged. Strict clippy now covers
  `--all-targets` and passes. The one real bug the gate found: the skill
  home was read by two code paths, so `machine_link` skill sync honoured
  `GUILD_SKILLS_ROOT` while the remote-context scan read the real home;
  `fs_bridge::skills_home()` is now the single reader. No test was deleted
  and no assertion was weakened.

- **A dead workspace mount is repaired, not served (2026-10-26).** A JuiceFS
  remount leaves every container that bound the volume before it on the dead
  FUSE session: the sandbox cannot start its agent (`transport endpoint is
  not connected`), the runner cannot create a workspace dir, and the chat
  shows `sandbox connection lost; outcome unknown`. The 2026-10-21 fix
  covered only the full-stack boot, and a sidecar-only restart skips it.
  Now the runner checks its own two volume roots every 10 s and before each
  ensure/attach: a dead one exits the process, the restart policy brings it
  back, boot re-resolves the mount and removes the sandboxes on the dead
  session. Attach also probes `/workspace` inside the container and removes
  a sandbox whose mount died. The server retries a 503 (and a refused
  connection) three times, 2 s apart, so a remount costs a few seconds and
  no failed tool call. The files never move: they live on the volume.

- **The sidebar lists are pushed, never fetched (2026-10-26).** A new chat's
  title could appear and then vanish: the client still re-read the chat list
  over HTTP after a create, and that snapshot (taken before the title model
  call finished) could land after the `thread_list` frame that carried the
  title. The sidebar now has one source: the member socket. The connect
  bootstrap and every list-changing write (title, rename, archive, project
  create/update/delete, machine registration, presence flip) run one
  serialized workspace push per user: `thread_list` (kept first for old
  clients), `archived_thread_list`, `project_list` and `machine_list`. The
  per-user chain makes a snapshot taken before a commit unable to overtake
  the one that carries it. The client drops every HTTP list read from the
  live path; settings keep their HTTP reads. A `guild_workspace` NOTIFY
  replaces `guild_thread_title` and also fires from the project and machine
  stores.

- **The read marker follows the route chat and is retried (2026-10-26).**
  Opening an uncached thread never marked it read on the server: the read
  frame was gated on the painted chat, and the first state of an uncached
  open is what triggers the swap, so the paint ref still named the old
  chat. The dot was hidden locally anyway, then came back on reload. The
  mark now keys on the route chat, hides the dot only after the frame left
  the socket, and is re-sent on every sync that applied a state (open,
  reconnect, tab wake) — the event-id guard throttles live frames only.
  A hidden tab no longer hides its own dot, and a `thread_list` push may
  hide an open chat's dot only after a read was actually sent. The store
  write is monotonic (`GREATEST`), so a late or repeated frame cannot move
  the marker backwards.

- **Machine presence is pushed, not polled (2026-10-26).** The sidebar's
  project dot and the settings machine list read `connected` from one HTTP
  snapshot taken at mount, so they stayed stale until a reload. The hub now
  fires `onMachineStatus` when a machine slot is claimed, released or
  displaced; the feed forwards it as a `machine_status` frame to the
  owner's member sockets. The client keeps the registry in
  `lib/machines-store.ts` and patches the flag in place; the HTTP list only
  seeds the store at mount and resyncs it on socket reconnect. Rule recorded
  in `AGENTS.md`: operational, status and chat state is pushed by the
  server, never polled by clients.

- **The rail carries the unread count (2026-10-25).** The Chats and Projects
  rail buttons show how many chats in their panel have an unseen assistant
  turn: folderless chats count under Chats, project-bound ones under
  Projects. Chat and project rows keep the plain amber dot. The feed now
  re-pushes `thread_list` when an assistant turn commits, so the badges move
  live in background chats instead of waiting for a title or approval push.
  A `thread_list` push never marks the open chat unread: the server read
  watermark lags the local read POST.

- **The inbox is gone; the chat list carries the attention state (2026-10-25).**
  Agent-initiated threads (routine messages, `send_message`) already land in
  the chat list with their unread marker, so the separate Inbox tab, page,
  badge and `/inbox` route are removed; an old `/inbox` link lands on Chats.
  Chat rows and project rows now also carry a `blocked` flag — a tool call
  waiting for approval — projected from the journaled `approval_request` with
  no later `approval_decision`, bounded to ten minutes. A blocked row shows a
  red dot that outranks the working spinner and the amber unread dot. The
  flag rides the existing `thread_list` push, re-sent when an approval event
  commits, so the sidebar moves live. Server notices stay for API consumers.

- **The skill file viewer shows every bundle file, and folders fold (2026-10-25).**
  `GET /api/v1/skills/:slug/source` now returns each file's text body
  (`content`, null for binary bodies and files over 256 KiB) by reading the
  published bundle, not just the version row's path/size/sha. The detail
  page renders markdown files as markdown and the rest as raw text, instead
  of "content not inlined", and directory rows in the file tree toggle open
  and closed.

- **One chat view: the agent's turn details fold into its work row (2026-10-25).**
  The casual/technical switch is gone, with its `/api/v1/me/settings`
  `chat_view` key. Every contiguous agent-work run — thinking, tool calls
  and subagent spawn/result/close records — renders as one collapsible row —
  "Agent is working 12s (4 steps)" live, "Agent worked for 7 seconds
  (4 steps)" settled — and the chevron opens the full technical detail in
  one container, indented under the label. A short or unstamped run reads
  "Agent worked", so its details stay reachable. Every detail row shares
  `FRAME_ROW_CLASS` / `FRAME_BODY_CLASS`, so subagent records and
  tool/reasoning rows keep the same padding and margins. The running
  subagent block follows the same shape: "Subagents working (N)" with a
  chevron that opens the tree.

- **The decomposition review is applied (2026-10-25).** Six files that
  mixed layers are split, with no behaviour change:
  `platform/context.ts` / `contexts.ts` became `root-context.ts` /
  `route-contexts.ts`; `views/sidebar-contents.tsx` became `views/sidebar/`
  (one panel per file plus `rows.tsx` and `chrome.tsx`); `lib/context.ts`
  became `lib/skills.ts`, `lib/turn-context.ts` and `lib/fs-bridge.ts`;
  `harness/runtime.ts` gave up the importer's `SharedPoolDatabase` and chat
  mapping (`importer/durable.ts`), the instruction composer
  (`harness/instructions.ts`), the title cleanup (`harness/title.ts`) and
  `directBaseTools` (`harness/agent-tools.ts`); `integrations/execute.ts`
  became one module per vendor under `integrations/vendors/` with the
  dispatcher left in `execute.ts`; `transport.ts` became `lib/session.ts`,
  `lib/machine-rpc.ts`, `lib/socket-client.ts`, `lib/thread-events.ts` and
  `lib/api/*`. `machine_link.rs` gave up the platform identity probes
  (`machine_meta.rs`) and the frame classifier (`machine_frames.rs`). New
  tests cover session addressing and tokens, the two thread reads, the chat
  write wire contracts, and the sidebar rows and panels. Still open: the Rust
  `jsonrpc_loop.rs` and the Tauri shell.

- **The chat view is the thread view (2026-10-25).** `views/WebChat.tsx`
  (4904 lines) is gone. The component is `views/thread/Thread.tsx` and the
  file name now matches the surface it renders and its `/thread/<id>`
  address. Pure derivations sit in `thread/route.ts` (`ChatRoute`,
  `parseChatRoute`, `chatRoutePath`, and the pure `applyRoutePatch` that
  `pushRoute` now calls), `thread/status.ts`, `thread/mentions.ts`,
  `thread/tool-text.ts`, `thread/approval.ts` and `thread/blocks.tsx`.
  Presentational widgets are `thread/tool-blocks.tsx`,
  `thread/approval-card.tsx`, `thread/attachments.tsx`,
  `thread/device-setup.tsx` and `thread/ThreadOverlays.tsx`. State lives in
  `thread/hooks/`: route, chat lists, thread store, composer/drafts,
  outgoing sends, member socket, approval mode and row actions. No behaviour
  changed. The pure test file moved with the code, the widget modules gained
  markup tests, and the route contract gained precedence tests.

- **Name and description are the agent; the workspace is only rules and
  memory (2026-10-24).** The identity split failed: the `agents.name` row
  said "Assistant" while `IDENTITY.md` said another name, and each UI
  surface read a different one. The `agents` row is now the only source of
  the name and the description. The UI shows both; the instructions and
  `list_agents` give the description to callers. `IDENTITY.md`, `SOUL.md`,
  `USER.md` and `BOOTSTRAP.md` are gone from the templates, the prompt and
  the workspaces: `AGENTS.md` (required) and `MEMORY.md` (optional) plus
  `memories/` are the whole workspace. Stable user preferences go in
  `MEMORY.md`. Existing `IDENTITY.md` names were copied into the row before
  the files were removed; Henry keeps his name.

- **The running subagent tree is pushed, not polled (2026-10-24).** The
  member socket gains `subagent_tree`: the chat's whole thread subtree with
  each node's latest run status, sent inside the `sync` bracket and again on
  a `guild_subagent_tree` NOTIFY. The NOTIFY fires on run create, run-status
  change and subtree cancel/close, and it fans out to every ancestor chat of
  the changed thread, because each ancestor may be open somewhere. The
  desktop drops its 5 s poll and the REST fetch; it replaces the node list
  from the frame. The tree renders the running part only, starts at the
  running children (the chat's own title is gone), and draws branch lines
  instead of bare indentation. Spacing from the transcript's last stamp
  grows to `mt-8`. Protocol: `WsServerMsg::SubagentTree`; SRS-56 and PRD-2
  record the rule that every live chat/thread UI update rides the socket.

- **A child result carries only its terminal text (2026-10-24).** The run
  lifecycle used to join the text of every assistant message in the turn,
  so a parent saw the child's tool narration ("I will check the files
  first") before the answer. `final_text` now comes from the terminal
  assistant event, the one with no tool call; earlier rows are narration.
  A stopped run with no terminal event delivers no partial text. Staged
  files still ride the terminal event's attachment rows.

- **A child result is never lost (2026-10-24).** Delivery takes the batch
  before the steer, so a steer that fails used to consume the result with
  nothing to carry it: the opened run lingered and the reaper failed it as
  `orphaned`. A failed steer now returns the batch to the unconsumed pool
  and fails its own run as `delivery_failed`. The five-minute stale sweep
  also re-delivers any `child_result` older than two minutes that no turn
  ever took and whose chat has no open run, which covers a delivery that
  died with its process. `failStaleRuns` writes an `orphaned` result for a
  dead child; the sweep is what now hands that result to the parent.

- **Projects archive like chats (2026-10-23).** The project row menu's
  Archive moves the project into a collapsed Archived section in the
  Projects panel; its row expands to its chats and its menu offers
  Unarchive. `GET /api/v1/projects?archived=1` lists the archived rows
  (most recently archived first), mirroring the thread list's `archived`
  query. Archiving still frees the folder for a new project.

- **An agent has an identity and a directory (2026-10-23).** `agents.description`
  is owner-editable, max 500 characters, and becomes the first line of the
  agent's own prompt. Every agent may rewrite its own description with
  `set_description`, which is outside the tool allowlist. The `subagents` group
  gains `list_agents`: the agents the caller's user may use, which is every
  non-personal agent visible to that user plus that user's own personal agent -
  another user's personal agent never appears. A failed spawn names the
  directory tool. Child chats stay out of every chat list through one shared
  execution-transcript predicate; the WebSocket `thread_list` push was missing
  it, which is how they reached the sidebar. `child_result` and the spawn/send
  result carry `chat_id`, so the child row opens the real child chat instead of
  treating a thread id as a chat id. Subagent rows are pinned above the
  composer, the spawner names each session (the row shows that name plus the
  agent's own), and a child thread opens read-only. Spec decisions 30-37a.

- **The mobile drawer carries the tab rail (2026-10-23).** The drawer showed
  the chats list only, so mobile had no route to inbox, agents, projects,
  activity or settings. It now renders the same rail beside the same panel
  as the desktop sidebar: panel tabs keep the sheet open, route tabs close
  it and render in the main column, and each panel header carries the drawer
  close. The skills tab is dropped on mobile (its page is desktop-only).
  Settings sections render inline on mobile too, and route pages (agents,
  skills, settings) get a drawer button because they own the whole column.

- **Agents talk to agents through the thread tree (2026-10-22).** `delegate`
  and `release_artifacts` are gone. A spawn creates exactly one child thread
  (`kind = 'delegated'`, `parent_thread_id`, `depth`); downward traffic is a
  turn in that thread, upward traffic is a `child_result` event plus one steer
  input merged into the parent's pending inbox item, drained once per
  boundary. The tool group `subagents` holds `spawn`, `send`, `read_thread`,
  `list`, `cancel` and `close`; `send_file` stays separate and now snapshots
  the bytes at call time, materialised per turn at
  `/tmp/attachments/<runId>/`. Shape bounds are depth 3 and 16 children per
  node; there is no budget. `close` cancels and archives the subtree and
  keeps its bytes. A user can read and cancel a child but cannot post into
  it. `cancel` across workers fails with `cancel_unreachable` until a
  `remoteStop` IPC exists. Spec: `docs/specs/2026-10-22-agent-to-agent.md`;
  plan and outcome: `docs/plans/2026-10-22-agent-to-agent.md`.

- **The agent gets its own tool set (2026-10-22).** A project-bound chat
  runs `read`/`write`/`edit`/`bash` on the user's machine, so the agent
  could not touch its workspace at all. It now also carries `agent_read`,
  `agent_write`, `agent_edit` and `agent_bash`, bound to the agent sandbox
  env and registered only where the chat is machine-bound. The set is
  outside the agent tool allowlist, counts as server-side for the shell
  allowlist and the batch contract, and maps to the same approval classes.
  `GUILD_SANDBOX=disabled` is gone: production requires a runner.

- **Desktop turns see the workspace and the project (2026-10-22).** An
  agent's instructions are its workspace files plus, on a desktop turn, the
  client-assembled chain (global config file and the project's AGENTS.md
  files from the git root down). The client renders pi's context syntax —
  one `<project_instructions path="…">` block per file — and the server
  wraps the blocks in a `<project_context>` section after the workspace
  files, cuts it at 32 KiB, and keeps the last chain per conversation so a
  resumed run sees the same text. The workspace files render the same way,
  inside `<agent_workspace path="/workspace">` with one
  `<agent_workspace_file path="…">` block per file, so the agent always
  knows which source and which path a block came from. The skills index already merges the client's local lines
  with the org catalog and drops org duplicates.

- **Activity is an admin surface (2026-10-22).** The rail entry, the
  `/activity` page, the trace and session deep links, and each agent's
  Activity tab are admin-only. A member who lands on one of those addresses
  is moved to the agents directory (or the agent's Overview tab) with
  `replaceState`, so Back does not bounce. The server keeps its row scoping
  (members read their own rows) as defense in depth. Verified live with a
  member account: no rail entry, `/activity` lands on `/agents`, and the
  agent Activity tab is absent.

- **Composer typing stays cheap on long threads (2026-10-22).** A keystroke
  re-renders the whole chat view, and a 3000-event thread holds thousands of
  markdown blocks. `WebChat` now memoizes the transcript element list, so an
  unchanged thread keeps identical element objects and React bails out of
  that subtree. Measured on the 3000-event dev thread: one keystroke went
  from 23 ms to 4 ms (median, headless Chrome).

- **Security hardening pass (2026-10-22).** A security review drove one batch of fixes. The
  Rust clients move to `rustls` 0.23.46, `rustls-webpki` 0.103.16 and the
  1.0.10 root bundles (distrusted-intermediate and TLS advisories); the
  dev-only npm tree moves to `vite` 7.3.7 and `vitest` 4.1.12 (audit now
  clean). `POST /api/v1/auth/login`, `/auth/bootstrap` and `/auth/pair` now
  pass a per-email and per-address sliding-window failure counter
  (`platform/http/login-throttle.ts`); ten failed logins on one email answer
  429 for the rest of the window. `loadConfig` refuses the example
  placeholders (`change-me`, the all-zero master key) when
  `NODE_ENV=production`, and the example config now says to generate real
  values. The user-MCP URL guard resolves the hostname and rejects every
  private address (allowlist: `host.docker.internal` plus
  `GUILD_MCP_ALLOWED_HOSTS`; RFC 2606 names pass because they never
  resolve). The SPA and the Tauri webview carry a CSP and the standard
  security headers. The global body limit drops to 1 MiB; the four upload
  routes keep their own larger limits. Attachment content types must match a
  MIME token. The internal gateway key compares in constant time. Left
  open by design: skill bundles publish without review (spec §1.3), and the
  file tools can read any path on a paired machine (the pairing is the
  grant).

- **Observability is one Activity surface: traces and spans, not a settings
  page (2026-10-22).** ClickHouse now owns the agent-observability model.
  `agent_traces` mirrors `agent_runs` (ReplacingMergeTree, 180-day TTL):
  trace id, org/user/agent, session (chat), parent trace, trigger, status,
  summary, error, start/finish. `agent_spans` holds immutable `llm` and
  `tool` spans (90-day TTL) with trace/span ids, parent span, model,
  tokens, cost, duration, status, input/output and attributes; the gateway
  writes LLM spans and the tool-task hook writes tool spans. One id links
  the story: the runtime resolves the chat's running run and sends
  `x-guild-run-id`, so every model call inside a turn carries the trace id
  and a judge call resolves it at settle time. A plain chat call falls back
  to the chat id as its trace id, and the chat id is always the session.
  `llm_calls` is retired for reads and writes; `llm_payloads` stays keyed by
  the request id (= LLM span id) and remains opt-in. API: `/api/v1/activity/
  {traces,spans,sessions,summary}` plus trace detail and admin-only span
  payloads; admins see the org, members their own rows. UI: the agents
  Activity page (and each agent's Activity tab) is now Traces | Calls |
  Sessions with a period picker, status/trigger/caller/model/search filters
  in the URL query, summary cards, a trace timeline, a transcript, and a
  span detail pane (input, output, attributes, payloads). The trace detail
  keeps `/runs/<id>`; `/settings/observability*` redirects to `/activity`.
  The settings section, its route contract and its test are removed. The
  model follows Laminar's trace/span/session vocabulary so the UI reads like
  modern agent observability rather than an LLM-call table. The agent turn
  route opens the run before `submitTurn`; `submitTurn` no longer opens a
  second one for adopted chats (each turn used to produce two runs and two
  traces). The surface keeps its status, duration, model and token data at
  the 900px desktop width, the timeline uses the trace's millisecond axis,
  and counts use singular forms. The trace detail now has Transcript, Tree
  and Timeline views: the transcript renders the run's user, assistant and
  tool steps and links each step to its span, and the tree nests tool spans
  under the model call that preceded them. Sessions get their own
  `/sessions/<id>` page with the session totals and its traces. The trace
  detail is a Laminar-style two-pane view: dense transcript rows show tool
  commands and result previews, the tree has aligned columns and one-line
  span previews, the timeline has a ruler and grid, and the span pane shows
  role-colored chat messages plus a syntax-highlighted JSON viewer with
  expand-all/collapse-all. The trace page uses the full window width with an
  adaptive span pane; input, output and attributes stack in one scroll
  instead of tabs. The trace view and the span pane scroll independently on
  wide windows, and the header stays fixed. The header title is the first
  line of the run summary; the full summary folds out in the trace pane.
  Desktop 0.5.99 carries it to installed clients.

- **A long thread reaches the client in pages (2026-10-22).** The member
  socket's ThreadState frame carried every durable event, and a live turn
  republishes that frame on each buffer change — so a long chat paid its
  whole history on every publish. The frame now carries the newest 120
  events and sets `has_more_events`; `GET /api/v1/threads/:id/events?
  before=&limit=` serves the page before a cursor. The client prepends a
  page when the reader scrolls to the top (or presses the top button),
  keeps the scroll anchor, and re-derives the merged window so cross-page
  tool results and approval decisions still join their blocks. A reconnect
  re-derives from the frame's own window: merging a loaded page onto a
  possibly non-contiguous tail could hide the rows between them. The full
  log stays on `GET /threads/:id` for the engine's turn assembly.

- **Agent config lives in the workspace, OpenClaw-style (2026-10-21).** The
  agent's identity, persona and operating rules moved out of the `agents`
  row into root files that the agent itself can edit: `IDENTITY.md` (one
  line: name, vibe, emoji, avatar), `SOUL.md`, `AGENTS.md`, `USER.md`,
  `MEMORY.md`, `BOOTSTRAP.md`, plus an empty `memories/`. Every new agent is
  seeded from the templates in `apps/server/src/agents/templates.ts` (never
  overwriting an existing file), and the thread's instructions are composed
  from the files on each turn (8 KiB per file, 24 KiB total, truncation and
  missing-file markers). `BOOTSTRAP.md` is a first-run ritual the agent
  deletes. The `agents.instructions` column is gone (migration 0086):
  `AGENTS.md` in the workspace is the only copy, and the UI reads the
  identity line (`identity` on the agent payload). Spec:
  `docs/specs/2026-10-21-workspace-agent-config.md`; re-seed a dev install
  with `npx tsx scripts/agents-reinit.ts`.

- **A skill pin is optional; an install follows the latest by default
  (2026-10-21).** `skill_installs.pinned_version` is nullable and NULL means
  "follow the latest published version". Every install path — the install
  route with no version, `read_skill`'s install-on-use, `push_skill`'s
  auto-install, `autoInstall` after a publish — now writes NULL, so a
  publish reaches every unpinned install without a re-install. An explicit
  `POST /api/v1/skills/:slug/pin` is the only writer of a version. The
  index says "(installed, latest)" for an unpinned row, the desktop badge
  says "✓ latest", and the detail page's update button only appears for an
  explicit pin that sits behind the latest.

- **The chat column resizes; the tail has a jump button (2026-10-21).** The
  central column was pinned to `max-w-3xl`. A drag handle on its right edge
  now sets one width for the message list, the composer and the loading
  skeleton; it persists in localStorage (`guild.chatWidth`), resets on
  double-click and nudges with ArrowLeft/ArrowRight. A floating button
  appears above the composer when the pane is scrolled away from the bottom
  and smooth-scrolls back to the tail.

- **Skill files never enter an agent workspace (2026-10-21).** A workspace
  belongs to the agent and outlives the conversation, so the turn-start
  materialization loop now skips agent-backed chats; a plain chat's
  throwaway sandbox still receives the pinned bundle. `read_skill` serves
  the registry bundle instead: the SKILL.md plus the additional files
  inline (binary files and files past a 160 KiB budget stay listed by name
  and sha256). An agent that wants to edit a skill writes its own
  `skills/<slug>` tree; a present local tree still wins over the registry
  and `push_skill` publishes it. Copies that earlier turns left in agent
  workspaces were removed.

- **Coding tools are direct; integrations stay script-only (2026-10-21).**
  The model calls `read`, `write`, `edit`, `list`, `bash`, `web_search` and
  the skill tools itself. Integration, MCP and thread-history tools stay
  behind `codemode` scripts. The agent's tool allowlist narrows the direct
  surface the same way it narrows integrations, and `codemode` is always
  present because it is the only path to the script-only tools.

- **Stop ends the turn even when a tool cannot be cancelled (2026-10-21).**
  The stop route waits for the conversation to go idle, so one hung tool call
  kept the chat generating and the button on "Stopping" for good. Three
  holes are closed. The attach handshake to the sandbox runner rejects on
  error or close (ws reports a failed handshake with the socket already
  CLOSING, so the old ready-state check never fired) and has a 30 s ceiling.
  A sandbox call stops waiting for the connection when its context aborts;
  the shared connect keeps running for the next call. The runner's Docker
  calls and the agent exec start have timeouts. Past 10 s without a settled
  stop, the supervisor kills the worker: the abort mark is already durable,
  so the respawned worker commits the aborted outcomes from the journal.

- **A volume remount no longer wedges the agent sandboxes (2026-10-21).**
  The JuiceFS sidecar remounts `/mnt/guild` in the host namespace on every
  start, which leaves the Docker bind volume's `_data` on the dead FUSE
  session. Every command in a sandbox then blocks or fails with
  `transport endpoint is not connected`, and the chat turn hangs. The
  sidecar now re-binds `_data` for each volume whose device is the mountpoint
  before it reports healthy, and the sandbox runner removes its project's
  sandbox containers on boot instead of adopting them (a container created
  before the remount keeps the dead session; its files stay on the volume).
  No manual `umount`/`mount --bind` step remains.

- **Chats pick their agent (2026-10-21).** The composer's model selector is
  gone. A chat shows its agent and can switch it from a dropdown
  (personal agent first, then agents the user can use; a shared agent carries
  a users icon). `GET/POST /api/v1/threads/:chatId/agent` reads and sets the
  binding; the turn body accepts `agent_id`. A plain chat is adopted by the
  caller's personal agent on its first turn; switching an existing chat keeps
  the transcript and moves the thread to the chosen agent. The model is the
  agent's, never a per-chat choice.

- **A personal agent is visible only to its owner (2026-10-21).** — no admin override, no
  org or team visibility. `visiblePredicate` handles `is_personal` first.

- **Threads are private; agents are shared (2026-10-21).** Design:
  `docs/specs/2026-10-21-unified-threads.md`. Every conversation is a thread of
  an agent; a thread carries the user on whose behalf it exists (caller for a
  message, routine creator for a cron run, parent's user for a delegation).
  Sharing an agent shares its workspace, never its threads.
  - `agent_threads.user_id` scopes every thread read, rename and turn; a
    second user of a shared agent gets their own default thread
    (`UNIQUE (agent_id, user_id) WHERE kind = 'default'`) and cannot see,
    rename or post into another user's thread. Verified live: a member of an
    org-visible agent reads the owner's thread as 404.
  - `agent_routines.created_by_user_id` and `agent_runs.user_id` record the
    run's user, so routine threads and inbox notices land in the creator's
    private list.
  - `agents.is_personal` marks the one personal agent per user (default name
    `Assistant`), created lazily on first use, always private, exempt from
    archive and delete. `MAX_AGENTS_PER_ORG` is gone: agent count is
    unbounded; limits are workspace quota and storage budget.
  - Agent list shows `owner / name`; names are unique per owner among live
    agents. Model labels always use the app alias (`Auto`), never the
    provider id.

- **Type sizes come from the theme scale (2026-10-21).** `packages/ui/src/theme.css`
  declares the only text steps: `text-3xs`, `text-2xs`, `text-xs`, `text-sm`,
  `text-base`, `text-lg`, `text-xl`, `text-2xl`, with unitless line-height
  ratios. Views use those names and never a raw `text-[Npx]`/`text-[Nrem]`
  size. To resize text, change the token — one value, every use.
  `html { font-size }` scaling is not a size control: it moves layout and
  spacing too, and it is banned.

- **Agent surfaces follow the chat product (2026-10-21).**
  - Agent threads render through the core chat stack: `/agents/<id>/threads/<tid>`
    resolves the thread's `chat_id` and feeds the normal transcript, tool
    frames, approvals, attachments and composer. The header keeps the agent
    identity and thread rename; sends go to `/agents/<id>/turns` with the
    command id, attachment ids and queue/steer mode, so agent runs still get
    their `agent_runs` row and the agent's model.
  - Routines are view-only in the UI. `list_routines`, `create_routine`,
    `update_routine` and `delete_routine` are agent tools; the Routines page
    opens a chat prompt for new/edit flows and renders human-readable
    schedules (cron stays stored, never shown as the primary label).
  - Codemode is part of the runtime, not an allowlist toggle. It is removed
    from the agent tool catalog and from existing `agents.tools`; the
    settings page says it is always available. Integration tools from
    enabled org integrations are listed in the catalog and selected per
    agent; the runtime narrows the integration extension and discovery list
    to the agent's allowlist, so unselected tools are neither declared nor
    callable.

- **Persistent agents are live on the local compose stack (2026-10-20).**
  Agent workspaces are a JuiceFS volume mounted in the **host mount
  namespace** by the privileged `pid: host` sidecar (`nsenter -t 1 -m -n`),
  because the Docker daemon and the sandbox runner resolve bind sources on
  the host. The server keeps a read-only `/workspaces` mount and a
  read-write `/workspaces-write` used only for delegation artifacts and
  purge; the runner creates always-on gVisor sandboxes under
  `agents/<org>/<agent>`. A host-namespace sweep keeps a 50 GiB JuiceFS
  quota on every agent directory. Restarting the sidecar requires remounting
  Docker's bind volume (docs/deploy-nuances.md §4b).
  - Delegation is worker-per-chat: a parent worker cannot admit a child
    chat, so admission is proxied over the fork IPC (`remote-submit`).
    Artifacts are written through the read-write mount and surface on the
    parent run (`run_id OR parent_run_id`).
  - Team visibility stores explicit `agent_team_grants`; the create wizard
    and settings both pick teams, and settings clear grants when visibility
    leaves `team`.
  - Delete is two-phase: `deleting` + `purge_after` (30-day default), the
    scheduler purges due agents and removes the workspace directory;
    archive and deleting agents are both restorable from the directory.
  - One-shot routines delete stale pending occurrences on disable,
    reschedule, manual run, or auto-disable. `send_message` dedupes the same
    agent/title within a minute. The inbox rail badge refreshes when a
    notice is read.
  - Limits: 2 vCPU / 2 GiB / 512 pids per sandbox (runner defaults,
    env-tunable), a 50 GiB JuiceFS quota per agent workspace; agent count is
    unbounded. `agents.resources` is recorded but not enforced.

- **Agent workspaces get a JuiceFS volume (2026-10-20).** Compose adds a
  `juicefs` sidecar (foreground mount, `/dev/fuse`, `SYS_ADMIN`, unconfined
  AppArmor, `rshared` host dir, `stat -f` healthcheck) and a one-shot
  `juicefs-init` that creates the dedicated `guild_meta` Postgres database.
  The `guild_workspaces` volume binds `${GUILD_WORKSPACE_HOST_DIR:-/mnt/guild}`;
  the server mounts it read-only at `/workspaces`, the runner read-write.
  The runner accepts `agents/<org>/<agent>` subpaths, creates their dirs on
  the agent volume, and never reaps them: agent sandboxes are always-on.
  `GUILD_AGENT_WORKSPACE_ROOT` is the server's file-browser root. The
  isolated instance (`scripts/agents-vfs-init.mjs`) is project
  `guild-agents-vfs`, :18093, db `guild_agents_vfs`, bucket
  `guild-agents-vfs`, dir `/mnt/guild-agents-vfs`; its only host
  prerequisite is `sudo mkdir -p /mnt/guild-agents-vfs`.

- **Skill provenance reaches the agent (2026-10-20, 0.5.83).** An agent
  asked "whose skill is that?" and could only answer from the SKILL.md's
  prose, because the index, `search_skills` and `read_skill` dropped the
  registry's provenance. Every agent-facing surface now carries it: the
  machine's index line reads the install sidecar (`agents/guild.yaml`) and
  appends `[registry v2, published by X, on <date>, installed <date>]`, or
  `[local]` for a folder Guild never installed; the sync payload carries
  `publisher` and `published_at` into that sidecar, and
  `skill_installs`-driven pushes refresh it. Server-side, `searchSkills`
  returns the latest version's publisher label, publish time, owner label
  and fork origin (a new `SkillSearchRow`; `listItems` keeps its lean wire
  shape), the index org lines name the publisher, `search_skills` prints a
  provenance line per hit, and `read_skill` opens with a `Provenance:`
  paragraph — version, publisher, date, owner, fork origin, bundle sha.
  `itemControl` and `getVersionMeta` resolve owner and publisher labels, so
  the local-tree read names the owner too. Index guidance states the
  provenance is there.

- **The 2026-10-18 review's criticals are closed (2026-10-19, 0.5.82).**
  Project binding is owner-only: `lockBindableMachine` matches the machine's
  `user_id`, with the org kept as a tenancy filter — a project's folder is the
  workdir its chats execute in, so an org-wide bind was remote execution on a
  coworker's machine. An unmapped conversation now blocks command-bearing
  tools instead of failing open; non-command tools keep the pre-approved
  batch contract. The composer ignores Enter while an IME is composing. A
  malformed path escape parses to the default route and the address is
  rewritten, instead of throwing from the render-time route initializer. The
  route upsert runs in one transaction, so a rename onto a taken id or
  display name is a 409 from the index, not a lost race or a 500. Route
  display names are unique per org (case-insensitive; the empty default may
  repeat), and the context tooltip names the route that actually measured the
  usage instead of the currently selected one.

- **A turn naming a retired model runs on the default route (2026-10-19).**
  A chat pins no model: the picker offers the org's catalog, and the turn
  carries whatever the client has in hand. A tab opened before an admin
  changed the routes (or an older desktop bundle) kept sending the old id and
  the submission failed at `resolveRoute`. Submission now resolves the
  request against the org's enabled routes — a name still on the list is used
  as sent, anything else falls back to the default (first) route — so the
  turn succeeds and its assistant event records the model that actually ran.
  Dev's only route is aliased `Auto`, so the picker reads Auto while the wire
  id stays `deepseek-v4.1-flash`.

- **Model routes carry a user-visible name; the model id stays internal (2026-10-19, 0.5.81).**
  `model_routes.alias` is the display name the chat model picker, context
  ring and route pages show; the `model` column remains the wire id sent to
  the provider and the identifier API clients address. `/api/v1/models` keeps
  returning the id list for older clients and the Rust engine, plus an
  `aliases` map; a route without an alias falls back to its id until an admin
  names it. The admin route form now edits both fields, and a changed id
  renames the existing row in place (a rename onto an existing id is a 409,
  not an overwrite). Old thread entries and usage rows keep the historical
  id; that is data, not a live route reference. Dev compose serves 0.5.81,
  the migration is applied, and all six signed client artifacts are
  published.

Older decisions (before 2026-10-19): `docs/archive/decisions.md`.

## Where things stand

- **Server:** a TypeScript Fastify app on `pi-durable`, run by Bun with no
  compile step. The compose stack on `:18080` (`deploy/compose`) serves the
  API and the chat SPA baked into the image from `apps/desktop/dist`. State
  lives on the host services: Postgres db `guild`, ClickHouse for traces and
  usage, rustfs for objects. Agent workspaces ride a JuiceFS volume; tools
  run in gVisor sandboxes via `sandbox-runner`.
- **Version:** dev runs 0.6.42 (branch develop). Prod is a separate
  checkout (`~/guild-live`, branch master, port 18081), runs 0.6.40, and
  stays in supervisor mode; dev runs worker mode (`GUILD_WORKER_MODE=on`).
- **Clients:** desktop 0.6.42 is published on the dev updater manifest for
  all four platforms (six artifacts: Windows NSIS, Linux AppImage, macOS
  aarch64 and x86_64 DMG plus their updater bundles), minisign-signed.
  Installed clients pick it up on relaunch. Releases stay dev-controlled and
  deliberate.
- **Wire:** the client↔server contract is typed end to end, and
  `protocol/*.schema.json` is the contract: Rust and TypeScript are
  hand-written from it. Each client release is tagged `client-v<version>`
  (the first is `client-v0.6.42`), and `protocol/check.mjs` fails on a
  schema change that client cannot read. The model itself still carries migration history:
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
  (`--all-targets`), the Windows compile check (`scripts/check-windows.sh`),
  `node protocol/check.mjs`, `npm run coherence` and `tsc --noEmit` over
  the server, desktop and wire trees.

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
  Removes the per-type export tests. Precondition for picking the tool: it
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
  backend, project-derived executor binding, durable Restate workflows. The
  review rounds tightened contracts (auth generations, executor identity
  validation, effect-claim tombstones) without changing the architecture.

## Working conventions

- **Always redeploy after a change** — detached compose build+up from
  `deploy/compose`, then verify the live bundle hash and API health. The
  user tests against :18080.
- **Desktop-affecting changes ship a client release in the same task** —
  `scripts/release-clients.sh` against the dev manifest, then check
  `latest.json`.
- **Bump the version with `scripts/bump-version.sh <semver>`**, never by
  hand; the script covers every file the health endpoint and release
  scripts compare.
- **Sessions run this repo concurrently** — check `git log`/`git status`
  before and after editing; pull rather than clobber.
- **Review-loop branch topology:** `review/roundN-<agent>`, `fix/roundN`,
  `verify/roundN` worktrees, merged `--no-ff`, branches
  and worktrees retired after merge; orchestrator prompt/report files stay
  out of the repo root (reports live in git history).
- Comments describe what code IS and does now — no history narration. Docs
  like this file carry the story.
