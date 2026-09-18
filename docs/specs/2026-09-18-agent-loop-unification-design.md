# One agent loop + a thin desktop backend

2026-09-18. Owner decision (maintainer): Guild converges on exactly one agent
loop — the durable gateway workflow — and a desktop Rust backend that is
extremely thin: local tool execution only. The TS client owns interaction
with the server; machine-level requests are all it dispatches to Rust. This
is the parity strategy between web (server-only today, server-side sandbox
later) and desktop (server + thin local executor).

Verified against the codebase 2026-09-18; file refs are current.

## 0. Bottom line

Three agent-loop topologies exist today with two implementations of agent
semantics. That is accidental, not designed. The target:

1. **One loop**: the durable gateway workflow (`worker/restate.rs`
   `generate`) is the only place agent semantics live — tool loop, policy,
   approvals, history, context.
2. **Three tiers**: cloud server = brain (durable loop, history, policy,
   integrations, audit). TS frontends (desktop webview, browser) =
   interaction + context assembly. Rust (desktop host) = executor + a
   minimal file bridge + release/registry crypto.
3. **Executors are a taxonomy**, not architectures: `desktop machine` (via
   the machine WS), `server sandbox` (future — same dispatch shape, no hub
   round trip), server-local workspace execution (today's `agents.rs`,
   re-scoped or re-homed).

## 1. Verified current state

### Loop A — durable gateway workflow (the good one)

`crates/server/src/worker/restate.rs` `generate`. Journaled Restate
workflow: every step a journaled snapshot, replay on worker restart,
history in `thread_events` (server-owned), compaction, queue/steer,
approval journal, static exec policy (Starlark), integration tools with
classes/curation/`acting_as`/audit. Clients: desktop GUI chat, browser
chat, CLI `Guild chat` (via the daemon's `chat.send` → plain completion —
no tools, see §4.3).

### Loop B — `run_agent` (guild-core), two instantiations

`crates/guild-core/src/agent/mod.rs:115`. An in-memory `loop { model turn;
tools; approvals }`. Nondurable by construction.

- **B1 — desktop daemon `agent.start`** (`app-server/src/jsonrpc_loop.rs:420`).
  History in daemon memory (`session_store.rs`), approvals over JSON-RPC to
  the attached GUI, tools executed locally via `ToolRegistry`
  (`builtins_with_read_roots`) — builtins only: no integrations, no static
  exec policy, no curation, no compaction. Model turns ride the cloud
  gateway anyway (`agent_session.rs` `GatewayTurn`), so B1 has the cloud
  dependency without A's durability. Consumers: the engine stdio protocol
  and `engine_stdio` tests. **No TS caller exists** — the GUI never uses it.
- **B2 — server workspace sessions** (`server/src/http/agents.rs`).
  `run_agent` in-process on the server, tools scoped to a per-org workspace
  dir on the server's disk, history persisted as thread events. A headless
  execution backend (spec §10.6).

### Who owns what on the desktop today (the split that already exists)

| Responsibility | Owner today | File |
|---|---|---|
| Machine WS connection + `ToolDispatch` receive | Tauri host | `src-tauri/src/lib.rs:823` |
| Client tool execution (read_file/execute/edit_file/write_file) | Tauri host, `ToolRegistry::builtins()` | `src-tauri/src/lib.rs:1037` |
| Tool result return | Tauri host over machine WS | `src-tauri/src/lib.rs:1048` |
| Login/pair/session bootstrap | daemon RPC | `jsonrpc_loop.rs:291-292` |
| Session token storage | daemon (`~/.config/guild/token.json`), copied into webview localStorage | `App.tsx:265` |
| Skills list / `/name` expansion / skills index / AGENTS.md assembly | daemon RPC | `jsonrpc_loop.rs:460-466` |
| Registry install/publish (bundle crypto) | daemon RPC | `jsonrpc_loop.rs:451-459` |
| All server interaction (feeds, sends, history, attachments, projects, admin) | webview TS | `transport.ts`, `WebChat.tsx` |
| Engine loop (`agent.start`, `run_agent`) | daemon | unused by the GUI |

The GUI is already 90% "TS owns interaction". The engine loop is dead
weight the GUI never calls; the daemon's skills/registry RPCs are thin
features sitting on file/crypto primitives the webview cannot reach (Tauri
webview sandbox).

## 2. Target architecture

```
┌────────────────────────────────────────────────────────────┐
│ Cloud server (brain)                                        │
│  durable gateway workflow · thread history · policy layers  │
│  integrations · audit · model routing · artifacts           │
└──────────┬─────────────────────────────┬───────────────────┘
           │ HTTP + WS (one protocol)    │ machine WS
┌──────────▼──────────┐      ┌───────────▼────────────────────┐
│ TS frontends        │      │ Rust executors                 │
│ desktop webview     │      │ desktop host: machine tools +  │
│ browser (web mode)  │      │   file bridge + registry crypto│
│ CLI (headless)      │      │ server sandbox (future)        │
└─────────────────────┘      └────────────────────────────────┘
```

Invariant: **exactly one agent loop (the gateway workflow). A frontend
never runs agent semantics; Rust never talks to the model.**

- TS frontend: auth, sends, feeds, history rendering, approvals UX, project
  binding, **context assembly** (skills index, `/name` expansion, AGENTS.md),
  attachments, updater. State lives in the webview (like a browser tab) —
  the server's thread history is the durable copy.
- Rust desktop host: executes `read_file`/`execute`/`edit_file`/
  `write_file` when the workflow dispatches them; serves primitive,
  allowlisted file operations to the webview (so TS can assemble context);
  registry bundle crypto; pairing + machine identity.
- Server: everything else, for every host identically.

### 2.1 Executor taxonomy

| Executor | Dispatch path | Notes |
|---|---|---|
| `desktop` | machine WS → Tauri host → `ToolRegistry` | today's `client_tool_step`; unchanged |
| `sandbox` (future) | direct in-workflow execution against a server-side sandbox | same `ToolSpec`s, same policy/approval gates, no hub round trip; makes web chats fully agentic |
| `server-local` (today's B2) | in-process `ToolRegistry` on the server disk | keep as headless batch backend, re-scoped (§4.4) |

Adding an executor is a dispatch-shape change, never a loop change. That is
the parity guarantee: web gains agentic power by gaining executors, not by
growing a second loop.

## 3. The thin desktop backend — exact contract

The daemon and Tauri host merge into one Rust process (the daemon's
detach-and-survive lifecycle is retained; the Tauri GUI attaches as today).
Its complete surface:

1. **Machine executor** (unchanged): machine WS connection, `ToolDispatch`
   receive, `ToolRegistry` execution, `ToolResult` return, presence,
   termination-detection cooperation.
2. **File bridge** (replaces `skills.*` feature RPCs): primitive,
   allowlisted operations the webview calls over the existing RPC channel:
   `fs.read_text(path)`, `fs.list_dir(path)`, `fs.exists(path)`,
   `fs.write_text(path, body)`. Allowlist = the bound project folder, the
   skill roots, the Guild config dir — the same read-roots concept the
   engine loop already used. Discovery *logic* (frontmatter parsing, index
   budget, AGENTS.md chain assembly, `/name` matching) moves to TS; Rust
   only touches bytes.
3. **Registry crypto**: `registry.publish/install/verify` stay Rust
   (ed25519 + bundle pack/extract in `guild-core::registry`); exposed as
   the existing verbs, now called with primitive inputs.
4. **Auth store**: pairing, machine identity, and the CLI's session token.
   The webview owns its own login (direct `POST /api/v1/auth/...`, token in
   localStorage — identical to web mode); the host receives the token via a
   Tauri bridge for machine-socket auth (the WS already authenticates with
   a session ticket + machine binding, so no new credential class).

What disappears from Rust: `agent.start`/`run_agent` wiring, `session_store`
message mirroring, feature-specific skills/AGENTS.md logic, `chat.send`
completion loop.

## 4. Migration

Phased; each phase ships and deploys independently. No big bang.

**Phase 1 — kill loop B1 (the actual unification).**
`agent.start` becomes a shim: validate params, create/attach the cloud
chat, drive it through the same gateway workflow the GUI uses, and stream
the workflow's frames to the stdio client (mapping
`StreamEvent`/`ThreadEvent` → the engine protocol's events). Approval
requests flow through the journal like every other client's. Delete
`run_agent` from the daemon path; `guild-core::agent` remains only for B2
until phase 4. Engine parity notes: engine users gain integrations, exec
policy, durability, and journal-visible history; they lose nothing they had
(no offline model path exists).

**Phase 2 — context assembly to TS.** Port `skills.rs` discovery/index and
`agents_md.rs` assembly to TS (`apps/desktop/src/lib/context.ts`), backed by
the `fs.*` bridge. The daemon verbs `skills.list/prepare_turn` are removed
once the webview stops calling them. Server side: no change — `skills_index`
and `agents_md` remain additive request fields (the additive channel was
built for exactly this client-side ownership).

**Phase 3 — merge the daemon into the Tauri host.** One Rust binary in the
desktop app: executor + bridge + crypto + CLI auth store. The CLI verbs
keep working (they attach to the same process). `GUILD_DAEMON_BIN`/
`GUILD_DAEMON_SOCKET` overrides preserved for dev.

**Phase 4 — re-home B2.** Server workspace sessions stop using `run_agent`
as a *loop*: either (a) they become ordinary gateway chats with the server
registered as an executor for the org workspace dir (recommended — reuses
policy/audit for free), or (b) they are documented as a batch backend whose
contract is "no policy layers, no approvals, trusted workspace". Pick (a)
unless batch callers need fire-and-forget semantics the journal makes
awkward. Delete `guild_core::agent::run_agent` when the last caller goes.

**Phase 5 — web parity completions (sequenced separately).**
(a) Machine-mediated AGENTS.md fetch: one `read_file` dispatch through the
machine channel at turn start for web chats (cached per project + mtime);
(b) the `sandbox` executor for web chats with no desktop present.

## 5. Consequences and trade-offs

- **Parity by construction**: a feature lands in TS + server once; desktop
  and web differ only in which executors are attached.
- **Single policy surface**: exec policy, curation, approvals, audit exist
  in exactly one place. The AGENTS.md double-wiring of 2026-09-18 becomes
  structurally impossible.
- **Durability for engine users**: CLI/stdio runs replay instead of dying
  with the daemon.
- **Webview trust**: the file bridge widens what a compromised webview can
  read. Bounded by the allowlist; note the model can already reach the same
  paths through approved tool calls, so the marginal exposure is small —
  but the allowlist is the security boundary and must stay an explicit
  list, never "anything under $HOME".
- **TS context assembly and web mode**: browser tabs cannot read files, so
  TS assembly is desktop-only by nature — web parity for AGENTS.md comes
  from phase 5a (machine-mediated) or 5b (sandbox), not from the bridge.
- **Latency**: the shim adds one gateway round trip per engine turn step —
  negligible against model latency.
- **Migration risk**: the engine stdio protocol is exercised by
  `engine_stdio` tests; phase 1 re-points them at the shim and keeps them
  as the contract tests.

## 6. Non-goals

- No protocol redesign: the WS protocol and the additive request fields
  (`skills_index`, `agents_md`) are already the right seams.
- No local-model support in this doc: if offline model turns ever matter,
  that is an executor-side provider, not a reason to resurrect loop B1.
- No UI changes.
