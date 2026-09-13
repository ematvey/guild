# Single-process desktop app — in-person execution (spec)

Status: agreed with maintainer 2026-09-13. Driven by a live failure: the chat
worked but the server said "bound machine offline", because the presence
connection lived in the webview (which lost its SSE 2ms after boot and never
retried) while execution lived in the daemon.

## Decision

1. **One process.** No headless daemon. The GUI process hosts the engine
   (session, engine loop, local tool execution) directly. Closing the window
   collapses to the tray; the process keeps running. Real exit only from the
   tray menu (which ends in-flight tool runs — same semantics as today's
   daemon shutdown).
2. **One standing connection to the server**, owned by the app process
   (not the webview): the existing `/api/v1/events/stream` SSE with
   `machine_id` + `machine_name` params. It registers the machine
   (executor_acquire) and forwards client-tool dispatch frames. A heartbeat
   POST every 5s **upserts** the machine, so liveness survives a stream flap;
   the stream dropping no longer unregisters a running app.
3. **In-person execution** is the main pattern: the running app IS the
   executor. The webview stops executing tools and stops holding presence
   entirely — it is a pure UI over HTTP request/response and per-turn
   streaming.
4. **Per-turn delivery stays on the turn's own response stream** (the SSE a
   chat send returns). That is the turn's reply, not a parallel channel.
   Standing channels collapse to exactly one (the app stream above). The
   attach endpoint remains as the replay/catch-up source when a client loads
   mid-generation.

## What is deleted

- The child daemon: spawn_detached on attach, the Windows supervisor
  (ping/taskkill/respawn), the build-identity handshake, the pipe CLIENT,
  `daemon.hello`/`daemon.shutdown` wiring in the GUI. The whole 0.3.12/0.3.14
  pairing-hang bug class goes with it.
- Webview-side presence: `startEventStream` + heartbeat interval become
  web-only.
- Webview-side tool execution: no mid-turn folder pick, no `tool.run` rpc —
  the app process executes client tools when the server dispatches them.

## What is kept

- The local socket (`daemon.sock` / named pipe) and its JSON-RPC dispatch —
  hosted by the GUI process, for the CLI verbs (`login`, `chat`, `publish`,
  `install`). If the app is not running, CLI verbs fail with "start the Guild
  app first" (no spawn fallback — no headless mode). `daemon.hello` /
  `daemon.shutdown` remain on the wire for the CLI handshake only.
- The GUI's rpc surface to the webview (`login`, `pair`, `session.info`,
  `machine.name`, …) — unchanged wire shape, now served in-process over an
  in-memory pipe (`std::io::pipe`) through the same `run_connection` dispatch.
  The webview's rpc submit/poll bridge is untouched.
- Machine identity: the webview's localStorage `guild_machine_id` stays the
  single source (it keys existing chat bindings). The webview passes it to
  the app process once at boot (`set_machine_identity`); the app process uses
  it for the stream and heartbeats.
- Chat→folder mapping for tool execution stays webview-owned (run-in-folder
  state in localStorage); the webview pushes it (`set_chat_dir`) on open and
  on pick.

## Server changes

- `executor_touch` becomes register-or-refresh (upsert). The heartbeat
  accepts an optional `machine_name` (used only when creating).
- `/api/v1/events/stream` becomes the **user fan-out bus** when connected
  with `machine_id`: besides org events, it tracks the org's active
  generations (poll the generations map every 500ms, subscribe to new ones)
  and forwards **all generation frames** — deltas, thinking, tool,
  approval, done/error — wrapped as
  `{"chat_id", "machine_id", "event": <StreamEvent>}` to EVERY connected
  device of the user (active or tray-inactive). `machine_id` is the chat's
  bound machine at generation start: the matching device executes the tool;
  the others render it. On connect, in-flight state is replayed
  (accumulated deltas + suspended tools), so a freshly connected or
  reconnected device is current without a separate attach call.
- Web clients (no `machine_id` param) get exactly today's behavior.

## Desktop app-process changes (lib.rs)

- `setup`: restore session → build one `Shared` → host the CLI socket
  (`run_daemon_on`) → create the in-memory pipe → `run_connection` (webview
  rpc) → spawn the **app-link task**: SSE connect loop + heartbeat loop +
  tool executor + result POSTing.
- Tray: window `CloseRequested` → hide; tray menu Open/Quit; single-instance
  plugin so a second launch focuses the running one.
- Tool execution: on a matching `ToolStarted` frame, run the builtin tool in
  the chat's folder (chat→dir map from `set_chat_dir`), POST the result to
  `/api/v1/gateway/chat/{id}/tools/{call_id}/result`, emit the frame to the
  webview for logging. No folder mapped → error result ("use Run in
  folder…"), so the model can tell the user.
- Result/approval POSTs use the engine session token (reqwest).

## Webview changes

- `transport.ts`: `startEventStream` becomes web-only. Desktop listens for
  `app-presence` (machine chip) and `app-frame` (tool log) Tauri events.
- `WebChat.tsx`: desktop `handleToolEvent` renders only (execution moved to
  the app process); `set_chat_dir` pushed on chat open / folder pick; the
  blind mid-turn folder picker is deleted.
- Web mode: unchanged (webview keeps streamChat/attach/events as today).

## Failure-mode ledger (what each piece now survives)

| Event | Before | After |
|---|---|---|
| Webview SSE dies | machine unregisters → tools fail | nothing (presence is app-process) |
| App stream flaps | n/a | heartbeat upsert re-registers ≤5s; tools keep running |
| App quits (tray quit) | daemon keeps running headless | tools abort after TTL — explicit user action |
| GUI webview reload | presence lost (was) | UI reloads, reattaches; presence unaffected |
| Old-version daemon leftover | pairing hangs | no daemon to be leftover; CLI handshake shuts a stale one down |

## Out of scope (kept for later)

- Sidebar per-chat generating/unread status.
- Moving attachments/uploads into the app process.
- Full desktop sign-out (engine session clear) — unchanged behavior.
