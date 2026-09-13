# Plan — single-process desktop (2026-09-13)

Spec: docs/specs/2026-09-13-single-process-desktop.md. Branch: single-process-desktop.
Target: desktop 0.3.16, server redeploy, devbox deploy, live verification.

## T1 server — heartbeat upsert
- state.rs: `executor_touch(machine_id, user_id, name)` → acquire-or-touch
  (keep existing name when the new one is empty). Update the two callers.
- chats.rs heartbeat handler: accept optional `machine_name`.
- Test: touch on unknown id registers; touch with empty name keeps label.

## T2 server — app stream (tool dispatch on events/stream)
- events.rs: with machine params, after acquire: load user's chat
  bindings once per 2s tick, subscribe to new active generations, forward
  ToolStarted/ApprovalRequested/ApprovalResolved wrapped with
  {chat_id, machine_id}; on connect replay pending client tools for this
  machine's chats.
- Client-tool frame filter: only frames for chats bound to THIS machine_id.
- Test: register two machines, generation on chat bound to A — only A's
  stream sees the tool frame; web stream (no machine_id) unchanged.

## T3 desktop Rust — in-process engine
- lib.rs: delete supervisor/pipe-client/daemon-attach; `std::io::pipe` +
  `run_connection` for the webview rpc; host `run_daemon_on` (CLI socket);
  commands unchanged. Remove spawn fallback in daemon::attach (CLI fails
  cleanly when app closed).
- Tray + close-to-tray + single-instance; Quit ends runs.
- tauri features: +tray-icon; dep: tauri-plugin-single-instance.
- New `AppLink`: SSE connect loop (machine params, session token), 5s
  heartbeat (upsert), tool execution on matching ToolStarted frames
  (chat→dir map), result POST, presence + frame emits to webview.
- Commands: set_machine_identity, set_chat_dir (replace EngineState wiring).

## T4 desktop webview
- transport.ts: desktop skips startEventStream/heartbeat; new app-frame /
  app-presence listeners; sendChat keeps POST (unchanged endpoint).
- WebChat.tsx: desktop tool frames render-only; set_chat_dir pushes; delete
  the mid-turn picker + tool.run path; wire presence into the header chip.

## T5 verify
- cargo nextest -p guild-server (host services); cargo test -p guild-desktop;
  tsc + vite.
- Deploy compose (:18080); publish desktop 0.3.16 (release-clients.sh);
  deploy exe to devbox; live-verify: chat + machine tools end-to-end
  ("whats here" lists the folder), window close → tray, tool run with
  window closed, CLI verb against the running app.

## Traps
- tauri command futures must be Send — no std Mutex guards across await.
- events.rs PgListener is standalone by design — keep it that way.
- The old 0.3.15 daemon may still be running on devbox at upgrade: its CLI
  handshake mismatch shuts it down; the new app hosts the socket.
- WebChat is shared web+desktop — branch on isTauri, never on server origin.
