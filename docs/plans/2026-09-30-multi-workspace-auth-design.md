# Multi-workspace auth — design spec

Date: 2026-09-30. Status: approved (maintainer: "looks right" on the 6-section
design; chose "both live simultaneously" over single-active switching).

## Goal

The desktop client holds sessions with TWO different guild servers (different
domains) at once and switches between them in the UI. Both servers see the
machine online; either can dispatch tools. One daemon, N live sessions.

## Non-goals

- Multiple identities on the SAME server (the store keys on base_url).
- CLI multi-workspace: the `guild` binary keeps reading `token.json`, which
  mirrors the ACTIVE session only.
- Simultaneous machine links to the same server — the hub already rejects a
  second connection while a live slot holds the row (0.5.25).

## 1. Session store (`crates/app-server/src/session_store.rs`)

New `workspaces.json` in the guild config dir:

```jsonc
{
  "active": "https://ws-a.example.com",   // base_url of the active session, null when none
  "workspaces": [ /* StoredSession[], unchanged shape */ ]
}
```

- `StoredSession` keeps its current fields (base_url, token, email,
  machine_id, client_id, machine_name).
- Migration: on restore, missing `workspaces.json` + present `token.json`
  adopts the single session as the sole entry and marks it active.
- `token.json` remains a mirror of the ACTIVE session, written on every
  transition — the watcher, external CLI logins, and any reader of the
  single-session file keep working. An external `token.json` write replaces
  the active entry (same semantics as today).
- Same atomic sibling-tmp save discipline as `token.json`.

## 2. Auth state (`crates/app-server/src/auth_state.rs`)

`AuthState` becomes a map of base_url → per-workspace auth (cloud client,
email) plus an `active: Option<String>` pointer. `machine_id` and
`client_id` stay per-install — one machine identity shared by all links.

- The invariant survives: every transition goes through ONE method doing
  mutate ⇒ persist (`workspaces.json` + `token.json` mirror) ⇒ publish.
- `AuthChange` variants:
  - `Login { base_url, token, email }` — adopt-or-replace the entry for that
    base_url AND make it active (login/pair semantics unchanged from the
    caller's view).
  - `Identify { machine_id }` — applies to the install, publishes to all
    live links.
  - `SignOut` — drops the ACTIVE workspace (kept as the default so existing
    callers don't change); new `SignOutWorkspace { base_url }` drops a
    specific one.
  - New `Switch { base_url }` — validates the entry exists, flips the active
    pointer, persists, and re-mirrors `token.json`. Link channels are keyed
    per workspace, so switching changes no link config — nothing is published
    to the links on a switch.
- Restore validates EVERY workspace via `cloud.me()` like today:
  unauthorized → keep the entry with token cleared (switcher shows "sign in
  again"); transient network failure → keep the token; never drop the whole
  store over one dead workspace.

## 3. Machine-link registry (`crates/app-server/src/machine_link.rs`)

The single `watch::Sender<Option<MachineLinkConfig>>` in `Shared` becomes a
registry: `HashMap<base_url, watch::Sender<Option<MachineLinkConfig>>>`
behind a mutex, with one link task spawned per live workspace.

- Add workspace → registry spawns the link task and seeds its channel.
- Sign-out (per workspace) → channel gets `None`, the task exits (existing
  sign-out break-out), registry drops the entry.
- `machine.identify` publishes config to ALL live link channels.
- Client_id: one per install, used by every link (the WS presence key is
  per-server; cross-server uniqueness doesn't matter).
- Accepted consequence: both servers can dispatch tools to this machine
  concurrently. Dispatches are independent requests (per-dispatch workspace
  folder, shared executor registry) — the executor already processes them
  one at a time. Machine slots are per-server, so the 0.5.25 live-slot rule
  is unaffected.

## 4. RPC surface (`crates/app-server/src/jsonrpc_loop.rs`)

- New `workspace.list` → `{ active: base_url | null, workspaces: [{ base_url,
  email, has_token }] }` (`has_token` = the entry survived restore with its
  token; a cleared entry is the "sign in again" case — liveness is NOT
  re-verified per list call).
- New `workspace.switch { base_url }` → flips active, returns the same shape
  as `session.info`. Unknown base_url → error.
- `login` / `pair`: unchanged wire shape; adopt-or-replace + activate
  (section 2).
- `session.clear`: optional `base_url` param; absent = active workspace
  (unchanged for existing callers).
- `session.info`: unchanged (active session only).

## 5. Webview (`apps/desktop/src`)

Sidebar switcher: current workspace (server origin + user), other workspaces,
"Add workspace", per-workspace "Sign out".

- Switch flow: `workspace.switch` → read `session.info` → mirror
  `guild_token` / `guild.serverUrl` → full `location.reload()`. Reuses the
  existing restore path; no in-place state surgery.
- "Add workspace" renders the existing pair/sign-in card with a back arrow;
  login/pair activates the new workspace and the app enters it.
- Namespacing rule: every localStorage key whose data belongs to ONE server
  gains the server origin in the key (`guild:draft:<origin>:<chatId>` …).
  Migration on boot: un-namespaced draft keys adopt the active origin.
- `session.info` remains the webview's source of truth for what it's
  mirroring; the webview never stores non-active tokens.

## 6. Edge cases

- Dead token in one workspace: entry kept, token cleared, switcher shows
  "sign in again"; switching to it routes to the sign-in card for that
  server.
- Offline restore: all tokens kept, links retry on their own backoff.
- External `token.json` write (CLI login): replaces the active entry; the
  watcher's existing dedup/heal logic applies per active session.
- Same server twice: impossible — map keyed on normalized base_url.

## Testing

- Rust: store migration, multi transitions (adopt-or-replace, switch,
  per-workspace sign-out), registry lifecycle (spawn on add, exit on drop,
  identify fans out), restore with one dead + one live workspace, external
  token.json write semantics.
- Webview: draft namespacing + migration unit tests; switcher smoke via the
  existing test setup.
- Manual: pair into A, add B, both servers show the machine online; tool
  dispatch from either works; switch preserves per-workspace drafts; sign
  out one leaves the other live.
