# Machine registry + WebSocket transport design

2026-09-16. Decided with maintainer in a design-grilling session; every decision
below was explicitly confirmed. Replaces the SSE events stream, the HTTP
heartbeat, and the in-memory-only executor registry.

## 0. Bottom line

All agent-work interaction moves to WebSocket: every client connection (each
browser tab, each desktop app) is one persistent socket; each machine is a
singleton with exactly one socket. Machine liveness = socket connected. The
machine registry becomes a durable DB table (one row per pairing, hardware
fingerprint for re-pair adoption). Threads bound to offline machines show a
gray pill + warning banner and fail tool dispatches fast. Ships as a full
big-bang with no legacy endpoints.

Motivating incident (2026-09-16, "check this out" chat): the machine's 5 s
HTTP heartbeat kept flowing while its SSE delivery leg was a zombie behind
Cloudflare, so the server dispatched `execute` into a link that no longer
existed; per-user stream cap (3) was exhausted by leaked permits; the
eviction mechanism sat behind the same 429 gate, so the desktop could never
evict its own zombie. Root defect: liveness decoupled from the delivery path.
WebSocket collapses the two into one socket.

## 1. Transport

### 1.1 Scope

- Chats, thread list, presence, tool dispatch/results, comments — all ride
  the socket. The admin panel stays plain HTTP.
- The DB (thread log) remains the source of truth. The socket is the live
  fan-out path, not storage.

### 1.2 Connection model

- **Browsers**: per-tab sockets. Each tab connects with a stable `client_id`
  (localStorage). Tabs are broadcast *members*: many allowed, all receive
  fan-out. The one-connection/eviction rule applies to machines only — it
  exists to prevent duplicate tool execution, and tabs never execute tools.
- **Machines**: exactly one socket per machine id. A second connect evicts
  the first (newest wins): the server closes the old socket with a clean
  "displaced" close message, and the displaced app shows "taken over on this
  machine" instead of silently reconnect-fighting.
- **Machine socket is multiplexed**: it is both a broadcast member (receives
  all its user's chat events) and the tool executor (receives dispatches
  addressed to it). One reconnect path, one liveness truth, one singleton
  rule per client.
- **Liveness**: protocol ping/pong. Online = socket connected. No heartbeat
  TTL, no HTTP heartbeat task. A dead client is detectable in seconds even
  behind Cloudflare. The HTTP `/api/v1/machines/heartbeat` endpoint is
  removed.

### 1.3 State sync on connect

Every (re)connect is treated as a stateless client:

1. Server pushes the thread list relevant to the client (with pagination).
2. Client declares which chat is open.
3. Server streams that thread's history (full, or paginated with infinite
   scroll — full first) including in-flight state indicators: agent
   responding, tool calls waiting for approval or execution.
4. Client reconciles by overwriting local state with the server's state.

### 1.4 Ordering and sends

- **Log-then-broadcast**: a sent message is written to the thread log before
  it is broadcast. Every frame — snapshot item or live — carries its thread
  seq. Reconcile ignores anything older than the newest seq the client has
  seen; live frames arriving mid-snapshot supersede older snapshot rows.
- **Server decides, client accepts.** The client renders server echoes only;
  it keeps no merge logic. UI may look optimistic (instant feedback) but all
  in-flight state is server-owned. A send lost to a server restart is
  accepted as lost: the user retypes it.

### 1.5 Auth

- Browsers and desktop both connect with a **single-use short-TTL ticket**
  minted over the existing authenticated HTTP session
  (`/api/v1/ws/ticket` → connect with `?ticket=…`; server exchanges it at
  upgrade). Nothing long-lived lands in access logs; replaying the URL
  fails. Token-in-header is impossible on browser upgrades; raw token in
  query string is rejected for log hygiene.
- Machines authenticate with their device token, same ticket flow.
- Token expiry mid-connection: server sends `auth_required` and closes; the
  client refreshes credentials over HTTP and reconnects through the normal
  state-sync path.

### 1.6 Caps

- Sanity cap of 32 sockets per user (not a liveness mechanism). Over-limit
  connections are rejected with an explicit "too many connections" error so
  a runaway retry loop surfaces as an error state instead of hanging.

## 2. Machine registry (DB)

### 2.1 Identity

- The **server issues `machine_id` at pairing**; the pairing handshake
  creates the registry row and returns its id. The desktop stores what it is
  given. The client's locally generated UUID survives only as the
  pre-pairing transport key.
- **Hardware fingerprint** (Windows `MachineGuid`) is advisory, never
  authoritative: it is a hint used only at sign-in. A live registration is
  never re-keyed by a fingerprint change.

### 2.2 Re-pair and adoption

- On a fresh pairing, the server compares the reported fingerprint against
  existing rows of the **same org**:
  - **Match** → silent automatic adoption: the new pairing takes over the
    existing row (same `machine_id`, so all thread bindings keep working),
    the old registration is displaced per the singleton rule, `re_paired_at`
    is stamped.
  - **No match** → new row. The old row stays as-is and goes offline per
    socket liveness.
- Fingerprint resets on OS reinstall (accepted); MachineGuid alone is used —
  no fuzzy composite matching.

### 2.3 Row schema

One row per pairing:

- `machine_id` (PK, server-issued)
- `org_id` (stable), `user_id` (last pairing user)
- `label` (hostname)
- `hardware_fingerprint` (MachineGuid)
- `os`, `os_version`, `app_version`
- `last_ip` (raw peer addr; X-Forwarded-For trust is a separate later task)
- `first_connected_at`, `last_connected_at`, `last_seen_at`, `re_paired_at`

Writes: insert/update on socket connect and pairing adoption;
`last_seen_at` refreshed on a 30 s throttle off the socket ping; nothing on
disconnect (absence of socket is the disconnect). Liveness for the UI is
in-memory socket state; the DB row is the durable record.

### 2.4 Dangling bindings

- Thread bindings never change on their own: no auto-unbind, no successor
  hints. A thread bound to a dead registration shows "offline" until the
  user unbinds manually.

## 3. Thread UX

- The machine pill (e.g. `WORKSTATION`) reflects live state: normal when online,
  gray + "offline" when the bound machine has no socket. State rides the
  state-sync and presence-change broadcasts.
- Offline bound machine: one-line banner — "WORKSTATION is offline — tools won't
  run until it reconnects." Sending messages stays allowed (the agent can
  answer without tools). Tool dispatches fail fast at send time; in-flight
  tools resolve to errors via the existing machine-watcher logic, now with
  socket-based detection.
- Machines page (Settings → Machine) lists all registry rows, not just live
  sockets: green dot for connected, gray with "last seen X ago" for offline.
  Machines no longer vanish from the list when the app exits.

## 4. Rollout

Full big-bang: new WS protocol replaces SSE + heartbeat in one release. No
legacy endpoints are kept.
