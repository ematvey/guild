# WebSocket protocol (as built)

2026-09-16. This is the authoritative description of the Guild client↔server
communication protocol after the WS-transport rework (spec
`2026-09-16-machine-registry-ws-design.md` §1/§4). Design intent lives in
that spec; where the build deviated, this document wins. Types:
`crates/protocol/src/ws.rs`; server: `crates/server/src/http/{ws,hub,feed}.rs`;
desktop: `apps/desktop/src-tauri/src/lib.rs`; web: `apps/desktop/src/{transport.ts,views/WebChat.tsx}`.

## 1. Endpoints and auth

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/v1/ws/ticket` | POST | Mint a single-use connect ticket (authenticated HTTP session). |
| `/api/v1/ws` | GET (upgrade) | The WebSocket. Query: `ticket`, `client_id`, optional `machine_id` + `machine_name` (desktop only). |
| `/api/v1/auth/me` | GET | Sanity/user info. |

- Tickets: single-use, 30 s TTL, in-memory (worthless after restart — the
  client mints a fresh one per (re)connect). Long-lived tokens never appear
  in the upgrade query string.
- Sessions: opaque tokens, sha256-hashed in Postgres, 30-day expiry. The
  ticket carries the session's hash + expiry; a watcher task sends
  `AuthRequired` and closes the socket 60 s before expiry (or on
  revocation). Clients refresh credentials over HTTP, then remint.
- Sanity cap: 32 sockets per user; over-limit upgrades are rejected with an
  explicit error.

## 2. Connection model

- **Browsers**: one socket per tab, each with a stable `client_id`
  (localStorage). Tabs are broadcast members — many allowed, all receive
  fan-out. No eviction between tabs.
- **Machines (desktop)**: exactly one socket per `machine_id` — the
  singleton. A second connect with the same id evicts the first (newest
  wins): the old holder is notified (`Displaced`) and closed; the slot
  switches atomically. Reconnection policy (desktop): a bare close retries
  with backoff; a stale instance's reconnect is answered with a
  pre-registration `Displaced` (server-side instance-ownership check via
  the app's instance UUID + `resume` flag), which is terminal — the stale
  app shows "taken over on this machine" and stops retrying until its link
  config changes. Only a fresh (non-resume) connect can take the slot.

## 3. Wire envelopes

JSON text frames, internally tagged by `type` (snake_case).

### Client → server

| Message | Fields | Purpose |
|---|---|---|
| `sync` | `chat_id: uuid\|null` | Declare the open chat (null = none). Server answers with the state-sync bracket for that chat. |
| `tool_result` | `chat_id, call_id, content, is_error, meta?` | Deliver a machine-tool outcome (funnels into the durable `complete_tool` handler; late duplicates no-op). |

### Server → client

| Message | Fields | Purpose |
|---|---|---|
| `hello` | — | Registration accepted. |
| `displaced` | — | This machine's slot was taken (terminal for a stale resume). |
| `auth_required` | — | Session expired/revoked; close and refresh. |
| `tool_dispatch` | `chat_id, call_id, name, arguments` | A tool execution addressed to THIS connection (machine sockets). Never replayed as display state. |
| `error` | `message` | Recoverable error notice (e.g. dropped frames → resync). |
| `thread_list` | `chats[]` | Full chat list (replaces the sidebar state; sent on connect and on change). |
| `chat_status` | `chat_id, generating` | Owner-scoped thread-list spinner frame. |
| `sync_begin` | `chat_id` | State-sync bracket opens for this chat. |
| `thread_state` | `chat_id, seq, events[], text, thinking, generating` | **The only rendered-content source.** Atomic authoritative view: durable thread events + in-flight buffers. `seq` is the watermark. |
| `sync_done` | `chat_id` | Bracket closes. |
| `live_frame` | `chat_id, generation_id, seq, machine_id?, event` | Non-replayable generation stream for command consumers (the machine's dispatch stream; other devices may render). View clients use `thread_state` exclusively. |
| `org_event` | `event` | Org-scoped event from the events NOTIFY channel. |

## 4. Connect and state-sync

1. Client: mint ticket → upgrade →
2. Server: register (machine singleton or member) → `hello` → `thread_list`
   → loop.
3. Client: `sync {chat_id}` for the open chat.
4. Server: `sync_begin` → `thread_state` (durable history + in-flight
   state) → `sync_done`.
5. Thereafter: committed changes broadcast a fresh `thread_state` (same
   watermark semantics).

Reconnect = a stateless client: the same sequence from step 1. Every
(re)connect reconciles by overwrite: a client applies a `thread_state` only
when its watermark is strictly newer than the last applied view.

## 5. Liveness (replaces HTTP heartbeat)

- Server → client protocol Ping every 5 s with a unique per-challenge
  payload; only the matching Pong (byte-compared) counts. An unmatched
  challenge expires after 10 s → socket closed, hub slot dropped, pending
  tool dispatches settle through their durable resolution (not the
  5-minute backstop).
- Every server write (ordinary, control, terminal) has a 1 s deadline;
  outbound backlog over 4096 frames latches overload and interrupts the
  writer.
- Desktop: 20 s read-silence deadline per message + 20 s bootstrap
  deadline; outbound queue 1024 (overflow = link dead → reconnect) with a
  16-slot priority lane for Pong/Close; per-write deadline 10 s.
- "Machine online" == its singleton slot is held by a live socket. There is
  no heartbeat HTTP endpoint and no TTL.

## 6. Tool dispatch and results

- Dispatch: a `tool_dispatch` message is addressed to the bound machine's
  socket; delivery is a socket send, so an offline/undeliverable machine
  fails fast (the durable watcher remains the backstop).
- Results: the desktop executes locally and replies `tool_result` over the
  socket; results funnel through the durable `complete_tool` handler —
  late/duplicate completions no-op.
- Reconnect: on a machine (re)connect, pending dispatches for its chats are
  reconciled against a per-machine claim registry — a dispatch whose
  machine changed hands is resolved as "connection changed; outcome
  unknown" rather than re-executed (side-effecting tools are never blindly
  re-run).

## 7. Echo and fan-out (multiplayer rule)

- Log-then-broadcast: a command (send message, approval decision) is
  written to the durable log first; the commit fires
  `pg_notify('guild_thread_committed')` in the same transaction, the feed
  re-captures and broadcasts the committed `thread_state` to every socket
  of the user — including the sender's. User turns carry a client-generated
  `user_message_id`; the optimistic pending marker settles only when the
  echoed event with that id arrives (HTTP acceptance is just an ack).
- Every device of the user receives every event of the user's chats;
  `chat_status` frames are owner-scoped.

## 8. Retired (removed) transport

- `GET /api/v1/events/stream` (SSE fan-out + app link) — removed.
- `POST /api/v1/machines/heartbeat` — removed.
- Per-stream `StreamGate` budgets and the in-memory executor registry —
  removed (liveness = hub socket state).
- `GET /api/v1/gateway/chat/{id}/stream` (attach SSE) and
  `POST /api/v1/gateway/chat/{id}/tools/{call_id}/result` (HTTP tool
  result) — removed; `POST /api/v1/gateway/chat` is a JSON command that
  acknowledges submission only.
- Kept HTTP: sends/approvals (commands), `POST /api/v1/ws/ticket`,
  thread/history reads, settings/admin surfaces.

## 9. Deployment coupling

- Server and desktop move together: both embed the shared
  `guild-app-server` lib and compare `CARGO_PKG_VERSION` in the attach
  handshake — bump `[workspace.package] version` on every release so a
  legacy daemon is told to respawn. Desktop updater artifacts are
  Tauri-signed (`~/.tauri/guild.key`, passwordless); `latest.json` is
  served from `/api/v1/updates/latest.json`.
