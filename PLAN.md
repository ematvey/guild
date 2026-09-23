# Guild — current state of work

Updated 2026-09-23 (devbox executor restored on 0.5.18; daemon tracing
enabled). Read this before touching the codebase; the requirements live in
`docs/PRD.md` (product) and `docs/SRS.md` (system contracts); deploy
nuances in `docs/deploy-nuances.md`, hang-patterns in
`~/workspace/hanging-commands.md`.

## 0.5.19 released — 2026-09-23

`scripts/release-clients.sh VERSION=0.5.19 BASE=:18080` with a directly
minted admin session (revoked after): all four platforms published
(AppImage, NSIS setup.exe, two DMGs + `.app.tar.gz` updater bundles),
sha256 server-verified; `/api/v1/updates/latest.json` serves 0.5.19 with
minisign signatures on all platforms. Ships the send-loss hardening, the
merged composer chip, and the GUI link-task pileup fix; the Windows app was
relaunched after publish so the auto-updater picks 0.5.19 up. Caveat: the
client binaries were cut from a working tree that already carried part of
the concurrent full-review remediation (uncommitted at build time) —
compiled clean and its tests passed, but 0.5.19 is not a pristine-tag
build.

## Full review remediation — 2026-09-23

The full-project review and its 37 concrete findings are preserved in
`docs/reviews/2026-09-23-full/REVIEW.md`; implementation, validation and
remaining limits live in `REMEDIATION.md` beside it. Work used at most two
subagents concurrently and preserved the concurrent 0.5.19 changes.

Chat submission now commits an immutable command and its user event in one
PostgreSQL transaction (`0055_turn_commands`). The command ID also identifies
the generation; a durable outbox delivers one queue head per chat with a stable
Restate idempotency key. The worker claims/completes commands durably; model
history uses execution order while the UI retains acceptance order. Retries
cannot change a command's body or owner, and delayed acknowledgments cannot
replace another turn's cancellation pointer. Cloud/CLI and WebSocket feed
recovery use the same generation identity.

Journal decisions, interrupted prefixes and event IDs are replay-stable.
Canonical tool-call IDs include invocation, model step and index. Server writes
have durable execution claims; interruption before result persistence reports
an unknown outcome rather than repeating a side effect. Usage is recorded per
model request (including compaction/judge), with stable request IDs deduplicated
in reports/quota totals. Compaction keeps complete tool groups and only the
latest synthetic summary.

Security fixes cover public workspace injection, argument-sensitive exec policy,
routine HTTP DNS/redirect boundaries, enabled-routine edits, MCP tenant/caller
identity and reconnection, browser-bound OIDC, bearer release downloads, and
serialized final-admin mutations. Engine fixes cover connection recovery,
filesystem cycles, bounded process output/tree cleanup, image and artifact
transport, headless identity, project identity, CLI paths and truncated provider
streams. Frontend sends own immutable text/files/context and account-scoped
prepared retries; newer drafts survive failures and navigation. Project skills
use `.agents/skills` with increasing specificity; remote projects never inherit
the sending desktop's local instructions.

Restate is pinned to its deployed digest and uses a persistent journal volume.
The 0.5.19 server/UI is live, with bundle `index-De5jrlDD.js`; 590 Rust and
152 frontend tests passed (12 existing tests ignored). Journal backup/copy
was verified and all 756 retained invocations survived cutover. The original
Restate node name is retained through compose `.env` to keep recreation safe.
Adopting the volume requires a stopped-container backup and byte-for-byte copy
before recreation; never deploy the mount empty on an existing installation.
The Docker Rust build defaults to four jobs to bound concurrent compiler memory
on the shared host. Server/UI deployment does not publish or install client
binaries. Routine timer initialization still needs an outbox for initial ingress
failure; full remote skill discovery and immediate artifact prefetch remain
follow-ups. See the remediation report for validation and release boundaries.

## Chat "Working" shimmer indicator — 2026-09-23

While a turn is generating, the chat log itself had no in-flow indicator
(only the composer send button and the sidebar thread spinner). Shipped a
ChatGPT-style shimmer label: `WorkingIndicator` in `@guild/ui`
(`components/working-indicator.tsx`) sweeps a brightness wave across the
letters via a new `--animate-working-shimmer` keyframe (theme.css) with
per-letter `animation-delay`. WebChat shows it under the log tail whenever
`streaming` (busy ∨ server generating) and the tail isn't already animating
— before the first token, after a finished/error tool frame, or on silent
gaps. A live text tail keeps its ▍ caret and live thinking keeps
"Thinking…" — no double indicator. This also retires the old
`streaming && blocks.length === 0` bare-Caret line, which was dead code
anyway (the empty-log branch never reaches the block pane render).

## Message-send loss diagnosis + composer hardening + chip merge — 2026-09-23

A user send (desktop app, 17:55:41) created the chat and uploaded the
attachment, but the turn POST (`/api/v1/gateway/chat`) never reached the
server — thread_events stayed empty and no agent started. Diagnosis:

- Server pipeline verified healthy end-to-end by a probe: minted a session
  directly in postgres, POSTed `/api/v1/gateway/chat` through the public
  URL (Cloudflare → cloudflared → :18080) — accepted in 0.7 s, ChatRunner
  ran, assistant replied. WS upgrade also 101 both direct and public.
- So the loss is client-side: between the attachment upload and the turn
  POST the desktop path runs ONLY `prepareTurn` (context assembly over the
  local-daemon RPC). Each fs call has a 15 s timeout, but the step makes
  many calls (skills discovery, AGENTS.md chain), errors are swallowed, and
  there was no overall deadline — a wedged local daemon stalls the send for
  minutes with zero feedback, looking exactly like "sent, agent never
  started". The sender app (DEVBOX-2, 0.5.14) was not inspectable.
- Composer hardening shipped: `prepareTurn` races a 10 s deadline and falls
  back to the typed text; the turn POST gets `AbortSignal.timeout(30 s)`
  with a friendly "send timed out … press send to retry" error block; the
  typed text is restored to the composer on a failed normal send.
- **WORKSTATION machine-link storm root-caused (Windows GUI leak)**: the
  "WORKSTATION" registry record is the user's Windows desktop app (HQ box).
  Traced in situ with `GUILD_DAEMON_TRACE=1`: the process runs hundreds of
  concurrent `machine_link::run` loops (~2600 trace lines/s, thread ids
  5–20 interleaving), each minting tickets — most fail client-side ("error
  sending request": local resource exhaustion under the hammer), a few get
  through (the server's logged 200s + 401s). Cause:
  `run_daemon_shared_reclaiming` spawns a fresh link task + token watcher +
  reaper on EVERY host cycle, and its bind
  (`create_pipe_server_instance` with `FILE_FLAG_FIRST_PIPE_INSTANCE`)
  fails instantly on this machine (zero `accept:` trace lines) with NO
  backoff and NO cancellation of the previous cycle's tasks — an unbounded
  task pileup, ~5–13 GB of commit per minute and pegged cores. The starving
  engine stalls the in-process RPCs — this is what ate the 17:55 send
  (context assembly never finished, so the turn POST never fired). Fixed:
  one live link+watcher pair per process (previous pair aborted at cycle
  start), `RECLAIM_POLL` sleep after a failed host cycle, and the failure
  is now traced (`daemon host cycle failed: …`). Still open: WHY the first
  pipe instance fails on this machine (stderr is unreachable in a
  windows-subsystem binary; the trace now captures the error text for the
  next run). This also supersedes the 401-storm theory for the "slow
  reconnect after a clean restart" gaps: a machine stuck failing its bind
  cannot link at all until the app restarts.
- Composer chips merged into one: the standalone machine pill (dot +
  "devbox") is gone; the project chip now carries the online dot +
  machine-suffixed label ("guild · devbox"), identical structure in new
  chats and existing chats. The dot renders only for a remote machine
  whose live state is known — the chat row for existing chats, the
  `machines` list snapshot for new ones (hidden while unknown).

## devbox executor outage diagnosis + daemon ops — 2026-09-23

Devbox's machine link dropped ~23 min after the 10:41 (+04) server
redeploy (10:41→11:04 reconnect; DEVBOX-2 3 min, WORKSTATION 18 min —
slow reconnect after a CLEAN server restart is systemic, not
devbox-specific; mechanism still unidentified — daemon logged nothing).
During diagnosis the link flapped once more (~11:10, quick self-recovery)
and the old daemon's memory peak was 22.3 G over 11 h. Actions taken:

- Killed the 6-day-old hung `cargo test -p protocol -p guild-app-server`
  (pid 2489388; zero open sockets — inert, just the leak PLAN flagged).
- Upgraded devbox's daemon 0.5.17 → 0.5.18: 0.5.18 AppImage pulled from
  the releases API via a directly-minted admin session (revoked after),
  sha256 matched the registered release, `guild verify` OK (ed25519 over
  sha256, key from `/api/v1/releases/signing-key`), extracted to
  `~/.local/opt/guild-0.5.18`, symlink repointed. The GUI/daemon link
  coexistence fix now applies to devbox.
- Enabled `GUILD_DAEMON_TRACE=1` on `guild-daemon.service` (dtrace lines
  now flow to `/tmp/guild-daemon-trace.log`; the daemon has NO stdout
  logging at all — the journal stays silent by design).
- Re-paired the machine (same machine_id d20cff27): `~/.config/guild/
  token.json` had been deleted at 03:12 (cause unknown — nothing wrote
  to `~/.config/guild` since; the old daemon kept running on its
  in-memory config, but any daemon restart would have parked the link
  forever). Minted a pairing token via `POST /api/v1/auth/pairing-tokens`,
  `guild login --token g1|https://guild.example.com|<secret>`.
- **Bug found (headless pairing gap)**: the daemon's `pair` RPC only
  applies machine identity when the caller passes `machine_id`
  (`adopt_login_with_identity`, jsonrpc_loop.rs:494) — the CLI's
  `login --token` never does, so a headless pair leaves token.json
  without machine_id, `config_from_store` returns None, and the link
  parks silently waiting for a config that never arrives. 0.5.13's
  "headless machines pairable" claim only holds if something separately
  sends `machine.identify`. Fix: have pair_task self-identify (generate
  or reuse a machine id) when the caller didn't pass one. The manual
  workaround used here: `machine.identify` RPC over
  `/run/user/1000/guild/daemon.sock` with the pre-existing machine_id
  (`{"jsonrpc":"2.0","id":1,"protocol":1,...}`).

Open: the 23-min reconnect gap needs one captured flap cycle (trace is
now on); monitor whether 0.5.18's coexistence fix stops the ~11:10-style
flaps.

## 0.5.18 released — 2026-09-23

`scripts/release-clients.sh` VERSION=0.5.18, BASE=:18080, all four platforms
published (AppImage, NSIS setup.exe, two DMGs + `.app.tar.gz` updater
bundles), sha256 server-verified; updater manifest serves 0.5.18 with
minisign signatures on all platforms. End-to-end check: AppImage downloaded
via a short-lived signed URL and verified offline with `guild verify` (ed25519
over the sha256). Admin session minted directly in the guild postgres for the
run, revoked after. Ships everything from review round 1 + the install/GUI
coexistence work (link ownership tied to socket hosting, token.json auth
watcher).

## Full-codebase review round 1 — 2026-09-23

Six review lanes (`docs/reviews/2026-09-22-full/`, SUMMARY.md is the index)
followed by six fix lanes plus one follow-up lane, all merged to master with
the full workspace suite green (`GUILD_TEST_PG_URL` required for
engine_stdio and the guild-server integration suites).

- **Exec policy (the review's one critical):** the repo no longer ships
  `exec_policy_local.rules` — the build treats the local layer as an optional
  deployment artifact, a build lint rejects allow rules that are
  shell-interpreter prefixes or bare `docker`/`ssh`/`systemd-run`/`sudo`/
  `curl`, and the gate demotes to Prompt on command substitution, glued
  redirects/operators, and newline-separated second commands (each vector has
  a regression test).
- **Executor flakiness (the user's top observed issue):** tool dispatch no
  longer runs inline in the machine-link reader loop (a slow tool can no
  longer starve pongs and tear the link down); the link ignores unknown
  server frames and frames with drifted `StreamEvent` variants instead of
  failing; the member (GUI) socket got the same tag-peek tolerance; the
  bounded drain aborts a wedged writer; WSL file transports are bounded;
  `fs_list` caps at 1000 entries; `read_file` caps at 8 MB with a truncation
  marker; the GUI reclaims the CLI socket after a stale daemon retires and
  always spawns its machine link; the member link backs off on Displaced
  instead of parking.
- **Daemon install unit:** coexists with a running Guild app — the unit owns
  the executor + machine link while active, the GUI's socket host retires via
  `daemon.shutdown` and parks (reclaiming when the unit stops), and auth
  propagates through a token.json watcher in whichever process hosts the
  link; verifies the retired host's socket released and the unit's daemon
  reachable, `Restart=always` + `RestartSec=5s`, and the shipped `Guild`
  binary dispatches `daemon install|status|uninstall`.
- **Server hardening:** machine slots require owner match before
  displacement/adoption; routine completions enforce the route quota,
  `http_call` refuses loopback/link-local/private/metadata targets
  (`GUILD_HTTP_TOOL_ALLOW_HOSTS` overrides), enabled-routine creation is
  admin-gated; the 5-minute approval auto-deny is a durable timer raced via
  `select!` (the reviewed `claim_approval` sketch would have deadlocked — a
  virtual object awaiting an awakeable holds the instance lock); overflow
  retry no longer detaches the stream channel; unknown thread-event payloads
  are skipped with a warning instead of failing the chat's history.
- **Desktop:** Windows CLI pipe gets a user+SYSTEM-only DACL; `list_dir` is
  allowlisted to home + `\\wsl.localhost\\`; the engine-recovery panic is
  fixed (handle assigned at setup); `token.json` saves are atomic;
  `guild-rpc.log` moved to a per-user 0600 cache path with a size cap;
  update checks debounced to one per 60 s.
- **Webchat:** the draft persist/restore effect pair no longer clobbers the
  destination chat's draft on switch (draft logic extracted to
  `lib/drafts.ts`, tested); first-send network failures land in the error
  path; the dead context gauge chain was deleted (server `thread.context`
  remains; re-wire it when the scroll-up loader lands); transports honor
  null-on-any-failure; drafts are GC'd and cleared on sign-out; sidebar rows
  are a div with a dedicated open button.
- **Protocol:** `Ws.ts` is generated from `WsClientMsg`/`WsServerMsg` now —
  the hand mirror is gone and the bindings freshness check covers the WS
  envelopes.

## TODO — thread list + thread messages: keyset pagination + scroll loading — 2026-09-22

Requirement: both the sidebar thread list and the individual thread
messages must paginate, with a loading indicator whenever the user
scrolls far enough (infinite scroll). Today both are load-and-render-in-full:
`list_events`/`list_chats` have no LIMIT, the WS `ThreadState` sync ships the
whole event log, `ThreadList` pushes ship the whole chat list on every
connect/presence flip, and the client renders every block/row
(`WebChat.tsx` `blocks.map`, Recents `grouping.visible`).

Design (agreed with the user):

- **Server keyset pagination** (offset is unsafe for append-only data):
  - `thread.rs`: `list_events_page(org, chat, limit, before_seq)` — newest
    page older than `before_seq`, returned ascending, `(rows, has_more)`
    via the limit+1 trick. DONE (in working tree).
  - `chats.rs`: `list_chats_page` / `list_archived_chats_page` keyed on
    `(created_at, id)` DESC with the same unread projection as
    `list_chats` (extracted to `LIST_SELECT`); all chat lists get an
    `, c.id DESC` tiebreak. DONE (in working tree).
  - `protocol/src/ws.rs`: `ThreadState.has_more_events: bool`
    (`#[serde(default)]`). DONE (in working tree).
  - REMAINING: HTTP params on `GET /api/v1/chats` (`limit`, `before`,
    `before_id`, `archived` — response `{chats, has_more}`; unpaged =
    full list, unchanged contract) and `GET /api/v1/chats/{id}/thread`
    (`limit`, `before_seq` — `{events, has_more, context}`); clamp limit
    1..=500. Cap WS pushes: new `feed.rs` helper (`thread_list_page`,
    cap 100) used by the three `ThreadList` push sites (ws.rs connect,
    feed.rs presence broadcast, chats.rs set_project broadcast);
    `refresh_bindings` keeps the FULL list (subscription bookkeeping).
    Cap the user sync: `run_sync_started` trims the captured `ThreadState`
    to the newest 200 events and sets `has_more_events` (capture_thread
    stays full-fidelity — feed.rs's own tests and the machine view at
    feed.rs:201 depend on it). Regenerate TS bindings: `cargo test -p
    protocol --features ts` (exports to `crates/protocol/bindings/` —
    AGENTS.md's `TS_RS_EXPORT_DIR=ts` is stale, export_to paths are
    relative to the package root).

- **Client messages (WebChat + thread-reducer)**:
  - Reducer: `ChatView` gains `rows: ThreadEventRow[]` +
    `olderAvailable: bool`; `applyState` seeds/merges rows and sets
    `olderAvailable` from `has_more_events` on first-state (incremental
    states keep the old value); new `applyOlderEvents(chatId, rows,
    hasMore)` prepends (merge-by-seq) and re-derives blocks while
    PRESERVING non-seq-keyed tail blocks (`unpersisted-*`,
    `live-thinking-*`, pending-send keys, `live-*` errors — detect via
    `!/^\d+:\d+$/.test(key)`); `ApplyResult` gains `olderAvailable` and a
    `prepended` flag; accessor `olderBounds(chatId)` →
    `{available, oldestSeq}` for the fetch cursor. `invalidate()` (socket
    reconnect) re-derives from the newest page only — loaded older pages
    are re-fetched on scroll; acceptable, document it.
  - transport: `ThreadState.has_more_events?`; `getThread(chatId, signal,
    {limit, beforeSeq})` → `{events, hasMore?}` (route is currently
    unused — becomes the scroll-up loader).
  - WebChat: `older` state `{available, loading}` synced from ApplyResult
    per open chat; onScroll (existing pane handler): `scrollTop < 400` →
    load; top spinner row; `useLayoutEffect([blocks])` scroll-anchor
    (capture `pane.scrollHeight` before dispatch, restore delta after —
    must not trigger the stick logic); auto-fill when the first page
    doesn't fill the viewport; in-flight guard keyed by chat id
    (loadingOlderRef).

- **Client sidebar (WebChat + projects.ts)**:
  - `mergeChatList(prev, page)` in projects.ts: update-or-insert every
    pushed/fetched row in `(created_at, id)` order (Date.parse compare —
    never string-compare RFC3339), then drop rows that fall strictly
    inside the pushed window (≥ oldest pushed row) but are absent from
    it (archive/delete removal); rows older than the window survive.
    Tests in projects.test.ts.
  - transport: `listChatsPage({limit, before?, beforeId?, archived?})` →
    `{chats, hasMore}`; `CHATS_PAGE = 50`.
  - WebChat: `chatsHasMore`/`loadingMoreChats`; `refreshChats` becomes a
    merge-into-existing page fetch (first load = replace); `loadMoreChats`
    keyedset cursor from the last row; `archiveChat` must remove the row
    explicitly (merge never shrinks); `onThreadList` uses mergeChatList
    and only sets busy from the push when the open chat is present (capped
    push may not contain an old open chat); SidebarContent: onScroll
    near-bottom on its scroll container → `onLoadMoreChats`, spinner row
    at the end of Recents. Project fold-outs keep their client-side
    "Show more" paging over the loaded window.

- Suggested constants: events sync page 200, older-page fetch 150, chats
  page 50, push cap 100, scroll triggers: messages top < 400px, sidebar
  bottom < 200px.

- Tests: server `thread_pagination.rs` (store pages walk to exhaustion,
  HTTP route params, archived pages, org scoping; harness pattern:
  `test_state_with_db` + `build_router` + oneshot, auth like
  thread_events.rs); reducer tests (prepend merge, tail preservation,
  dedupe, hasMore flag); projects.test.ts merge cases. Then the §2
  compose rebuild + live-bundle check.

- Working-tree state: the three files above carry the DONE parts, mixed
  with any other session's edits — keep them, build on top. The feed.rs/
  chats.rs route/protocol-binding/client work is untouched so far.

## TODO — machine link still flaps after the 0.5.17 watchdog; gateway KV-cache verification unfinished — 2026-09-22

**Bug (executor link recycles on devbox even on 0.5.17).** Symptom: link comes
up, serves one tool call, dies within ~1 min, repeats — in-flight calls fail
with "Machine connection changed", idle windows fail with "bound machine is
offline"; no self-recovery gap longer than ~1 cycle. Evidence gathered:
daemon journal silent through every drop; compose-server logs carry no
machine-link lifecycle lines at all; `/tmp/guild-daemon-trace.log` stops at
20:10 UTC because the restarted daemon (systemd unit) runs without
`GUILD_DAEMON_TRACE=1`. Working hypothesis: the client's 45 s idle watchdog
(`machine_link.rs`, `idle_secs()`) fires every cycle, i.e. the server's
challenge-pong liveness in `crates/server/src/http/ws.rs` (~line 354
challenge enqueue, ~375 liveness timestamp) either never pings MACHINE
sockets or its pong-deadline frees the machine slot each cycle while the
daemon keeps the socket open — verify which side kills it, then fix server
pinging of machine sockets (or make the daemon's ping/pong satisfy the
challenge) and add dtrace lines for `Displaced`/`Closed`/`AuthRequired`
link ends (currently silent), then capture one flap cycle with
`GUILD_DAEMON_TRACE=1` before/after the fix. Repro cadence observed
20:31–20:38 UTC: OK 20:31:29 → dead 20:31:31 → OK 20:33:01 → dead → OK
20:33:59/20:34:23 → dead 20:34:30ish. Also pending: kill the 6-day-old hung
`cargo test -p protocol -p guild-app-server` (pid 2489388 — its
machine_link_idle fixture logs "machine-idle" connects into the shared
trace file).

**Task (verify Guild keeps a stable thread prefix and hits the gateway's KV
caches).** Setup: llm-proxy (:8610) → single live sglang `glm-5.3-flash`
(:8649, `--enable-cache-report --enable-metrics`, UnifiedRadixCache);
proxy logs per-message SHA-256 (text+thinking+tool_calls) + system-block
breakdown to `~/llm/gateway/data/requests.jsonl` since 09-10 (97.9k reqs) —
built exactly for this diagnosis (see `STABLE-CACHING.md`). Analyzers ready
and already run: `/tmp/prefix_analysis.py` (raw per-user stability) and
`/tmp/prefix2.py` (classifies first/newthread/abort/REAL + Guild-tool
marker; outputs `/tmp/prefix2_out.txt`). Results: engine-wide
`cache_hit_rate` 92.6%; consecutive-pair prefix stability — maintainer 97.8%
(243 "real" misses are all same-second parallel 2-msg single-shots,
classifier artifact), member A 97.2% (58 real), Denis
member/Alexey member/member member ~96%, cascade 0 real; internal project
32% real-miss (clustered on Sep-10 + parallel single-shots — recheck
current behavior); member B 63% real-miss (her client re-serializes
history with changing mid-list system prompts, 217 tools — not Guild).
Open items: (a) zero requests in the whole log carry Guild's integration
tool names (`atlassian_*`, `firecrawl_*`, …) although this very session's
tool calls appear in `requests-responses.jsonl` — find where Guild
desktop's LLM calls actually terminate (suspect the guild-server provider
route → `http://192.0.2.10:8648` "Acme LLMs" bypassing this
gateway; identify what listens on 8648) and run the same prefix-stability
pass on that path; (b) check `proxy.js` `logBodyEntry` covers
`/v1/messages` + `/anthropic/*` (Guild may speak Anthropic wire); (c)
per-request `cached_tokens` cross-check for Guild sessions (ndjson lacks
it; sglang metrics/logs have it); (d) code-review the thread prompt
assembly (guild-core/app-server) for stability by construction — thinking
blocks preserved vs stripped, dynamic system content.

## Machine link liveness watchdog + anti-parking — 2026-09-22 (0.5.17)

Incident: devbox's executor link died mid-session (~23:56 +04) and stayed
offline ~13 h until the daemon was restarted. The daemon process never went
down and never reconnected. Root cause: the link is a plain WS with no
client-side liveness check — the server pings every ~15 s and frees the
slot when its pong deadline lapses (that's how the machine went offline
server-side), but on a half-open route (suspend, NAT expiry, Wi-Fi blip)
the server's close frames never reach the client, so the client's
`stream.next()` hung forever and the reconnect loop never ran. A clean
death (server restart → RST) DOES recover, which masked the bug until now.
Fix, all client-side in `machine_link.rs`: (1) idle watchdog — ping every
15 s, break the session when no inbound frame arrives for 45 s (env-tunable
for tests); (2) the shutdown-tail writer drain gets a 2 s timeout so a
wedged TCP write can't park the reconnect; (3) `AuthRequired` and
`Displaced` no longer park forever waiting for a config change that may
never come — they retry on a 60 s / 300 s backoff (sign-out still parks via
the `None` config). Regression test `tests/machine_link_idle.rs` (own
binary so the env knobs don't race the reconnect test; the silent server
must NOT read the socket — tungstenite only flushes auto-pongs on
read/write, so a reading loopback server looks alive).

## `guild daemon install` — supervised boot persistence (Linux) — 2026-09-22

The "powered on ⇒ executor online" guarantee rested on a hand-rolled
systemd unit on one machine; everywhere else the GUI spawned an
unsupervised daemon that died at reboot and stayed dead after a crash.
New verbs on the same binary: `daemon install [--linger]` (writes
`~/.config/systemd/user/guild-daemon.service` → `daemon-reload` →
`restart` if active / retire-unsupervised + `enable --now` if not),
`daemon status`, `daemon uninstall`. The unit's ExecStart prefers the
stable `~/.local/bin/<name>` launcher when it resolves to the running
binary, so symlink-repoint upgrades follow without reinstalling; otherwise
the canonical binary path is pinned. `daemon.shutdown` delivery moved into
`daemon::shutdown_running()` (send + bounded socket-release poll, never
blocks on a hung daemon).

**Auth propagation + GUI coexistence — implemented.** Link ownership is
tied to socket hosting: the process that hosts the CLI socket runs the
machine link, nobody else. The GUI's host task (`run_daemon_shared_reclaiming`)
loops for the process lifetime: while `guild-daemon.service` is
active/activating it parks with no bind and no link (the unit owns the
executor); while another daemon owns the socket it waits; otherwise it
binds, spawns the link + token.json watcher, and hosts until
`daemon.shutdown` retires it — a reclaim grace of 3 s keeps the GUI from
winning the bind race against a unit the installer is bringing up, and
retirement unlatches the shared shutdown flag so a later unit stop
(uninstall or daemon death) wakes the park and the GUI reclaims +
relinks. `daemon install` verifies the reachable socket owner is a Guild
daemon (the hello handshake), retires it, and brings the unit up. Auth
performed by another process (a GUI pair/login/sign-out while the unit
owns the link, or a CLI verb) lands only in token.json: the daemon's
machine-link loop polls the store's mtime every 1 s (`watch_token_store`),
reloads it on change, and republishes the implied config — or `None` for
a sign-out, which brings the link down — onto the watch channel, deduped
against the config it already holds. The link task itself is
shutdown-aware end to end (park, backoff, and reconnect all exit on a
retired host), so a socket host's death never leaves a link running.
`GUILD_TOKEN_PATH` overrides the watched store path (tests, custom
locations); `daemon_install::set_unit_active_override` pins the
unit-active probe for tests.
Also open: the Tauri updater replaces the binary without touching the
unit; a pinned-path ExecStart keeps serving the old build until
`Restart=always` re-spawns it (in-place replacement) or `daemon install`
re-runs (new path).

## Project "+" pre-pick survives the chatId switch — 2026-09-22

Bug: the project row's hover "+" created a chat that came out projectless on
the first try; clicking "+" a second time bound it. Root cause: `newChatInProject`
set `pickedProject`, then navigated to the scratch view — and the `[chatId]`
effect's per-chat reset (`setPickedProject(null)`, "a pending pick never carries
over") ran after that same navigation and wiped it. From an open chat, chatId
changed → wipe → first send called `createChat` with `project_id: null`. A second
click found chatId already `null`, the effect didn't re-run, and the pick stuck.
Fix: `scratchPickRef` carries the pick INTO the switch it is part of; the effect
applies it only when the destination is the scratch view (`pickAfterChatSwitch`
in `projects.ts` — entering an existing chat still drops any pending pick).
Frontend-only; tests in `projects.test.ts`.

## 0.5.16: the GUI's CLI socket host shares the webview's Shared — 2026-09-22

The "unknown machine" on fresh pairs persisted through 0.5.15. Root cause
(proven by restart-test + pipe-probe on devbox/workstation): the GUI setup built
ONE Shared for the webview's in-process engine, but hosted the CLI socket
via `run_daemon_on(path, session)`, which built a SECOND Shared and spawned
the machine-link task on THAT one's watch channel. Webview pair/login/identify
published the link config where nobody listened; the link only came up from
the daemon-loop's boot-time seed (restored token.json) — i.e. on the NEXT app
start. Fresh pair + immediate project create = "unknown machine"; every
registration lagged one restart (why devbox/HQ with old persisted sessions
looked fine). Fix: `run_daemon_shared(path, shared)` — the GUI passes its own
Shared; the comment's "one session, one dispatch surface" is now true in
code. Verified end-to-end on devbox: wipe → install 0.5.16 → pair over the
daemon pipe → machine link connected 0.8 s after pair, WORKSTATION registered
(0.5.16), project create returned 200. Released 0.5.16 clients (all four
platforms). The pair/login-carry-machine-id change (previous entry) stays:
it makes the link atomic even for a real standalone daemon.

## Pair/login carry the machine id — 2026-09-22

Incident: a fresh-install user (k.tyurin) paired at 14:07:42, created a
project at 14:08 — three 400 "unknown machine" from `POST /api/v1/projects`.
Root cause: pairing creates only a session; the machine row is inserted when
the daemon's executor (machine) link connects, which needs the webview's
`machine.identify` rpc — a second step that failed silently (`afterAuth`
swallowed the error), so the link never came up and the registry never saw
the machine. Fix: the `pair` and `login` daemon rpcs now accept the webview's
stable machine id and bring the executor link up atomically with login
(`adopt_login_with_identity`); older shells without the field keep the
identify fallback. The webview no longer swallows identify failures — a
toast tells the user the machine didn't register and to restart the app.
Desktop daemons need a client release to pick up the daemon half; the
webview half ships with the server frontend.

## 0.5.14 released: remote machine folder browse — 2026-09-22

The create-project dialog's remote machines were dead rows ("browse coming
later"); devbox (a headless Linux box running only the daemon) could not
receive projects at all. Remote machines are now browsable like WSL distros:
new `MachineRequest`/`MachineResponse` control-plane frames over the machine's
executor socket (`protocol::ws`), a hub request/waiter map (`machine_request`
— 10 s timeout, offline/send/timeout/rejected errors), the owner-scoped
`POST /api/v1/machines/{id}/fs` endpoint (ops `fs_list`/`fs_home`, read-only,
the daemon answers straight from `tokio::fs` in machine_link), and a
`RemotePathSpecifier` reusing the WSL browse state machine on plain Linux
paths. Remote rows now show the live/offline dot. The pairing-code login verb
shipped in 0.5.13; the web-issued code's embedded URL is the REAL server URL
now (commit 4112483) — codes minted from inside a desktop webview still carry
`tauri.localhost` and are unusable on other machines.

Incident worth knowing: mid-release, the developer's real
`~/.config/guild/token.json` vanished (dir mtime 13:32, exactly when the full
test suite ran). Every test file checked uses isolated XDG_CONFIG_HOME or
temp paths — culprit unidentified. Symptom: the devbox machine link dropped
and did not reconnect (restored session empty). Re-paired; if a dev machine
mysteriously drops its pairing after running `cargo test`, this is why.

## 0.5.13 released: `login --token` (pairing-code CLI verb) — 2026-09-22

The engine already redeemed web-issued pairing codes (`pair` JSON-RPC method,
GUI pairing screen), but the CLI only exposed `login --url/--email/--password`.
`cmd_login` now takes `--token <code>` (alias `--code`) instead: the code
carries the server URL itself (`g1|<url>|<hex-secret>`), so no `--url` is
needed; the email/password path is unchanged. This makes headless machines
pairable without a GUI — the daemon service pairs from the shell. Version
bump in workspace Cargo.toml, package.json, tauri.conf.json (+ desktop crate
to 0.3.35); released via `scripts/release-clients.sh` with a directly-minted
admin session row (revoked after).

## Stuck-generation sweep: paused Restate invocations + unbounded provider connections — 2026-09-20

maintainer (user report, DESKTOP-TEST): an agent turn hung forever — script
crashed (normal, returned to the model), but the chat spun on; stop did
nothing; the user archived the chat and lost all access to it while it kept
spinning; the state survived desktop restart and PC reboot (the turn is a
Restate virtual-object workflow — the desktop is only the GUI). Live
inspection found the true state: the `generate` invocation was **paused** —
Restate parks invocations it cannot make progress on (journal-mismatch
family); a paused `generate` never ends, never clears its chat's flag, and
nothing in Guild could reach it: the startup sweep only kills *stale-version*
invocations (a current-version one is assumed to replay) and its
`chatgen_inv` record was already consumed, so stop/archive had no registry
entry (graceful flag) and no record (kill fallback) — dead end.

Fixes, four layers. (1) **Provider connections are bounded**
(`guild-core/src/provider/{openai,anthropic}.rs`): connect 15 s, response
headers 60 s (tokio timeout around `send()`), per-read idle 120 s
(`read_timeout` — also covers the streamed body). Previously the reqwest
client had no timeout at all: a provider that accepts the connection and
stalls pins the journaled model-call step forever, and the streaming loop's
250 ms cancel tick only starts once a stream exists — stop could never land.
(2) **Stop responsiveness while connecting** (restate.rs turn loop): the
connect phase polls the cancel flag on the same 250 ms cadence (future
pinned once — recreating it per tick would abort the handshake forever); a
stop during connect yields an empty `stopped` completion the epilogue
settles as interrupted. (3) **Stop/archive are guaranteed escape hatches**:
both endpoints route through `gateway::abort_generation` — graceful cancel
flag when the registry tracks the turn, hard kill of the recorded invocation
otherwise (old 409-when-idle contract retired; killing also clears a stale
flag, self-healing the spinner); archiving a generating chat ends its run
(the sidebar drops archived chats — a still-spinning one was unreachable).
(4) **The sweep catches paused/failed invocations**
(`kill_stuck_chat_invocations`, worker startup + hourly next to the prune
loop): the admin SQL endpoint (`/query`, `accept: application/json`)
enumerates paused/failed ChatRunner `generate` invocations regardless of
record state; each is killed (`PATCH /invocations/{id}/kill` — this
Restate's current endpoint; the DELETE `?mode=kill` the record sweep uses is
deprecated-but-supported) and its flag/registry entry cleared. Archived
chats are now visible: `GET /api/v1/chats?archived=1` + a collapsed
"Archived" sidebar section whose rows open by direct link and offer
Unarchive. Remediated the live stuck chat (kill + flag clear) before the
deploy. Full suite green (475, -j 12 — 48-way parallelism on the shared
host flakes the 30 s frame-wait tests, passes at lower concurrency), tsc +
vitest 121 clean; redeployed twice (sweep landed after the first).

## Projects are strictly owner-scoped, admin bypass removed — 2026-09-20

maintainer saw Ramil's projects (DESKTOP-TEST) in his own project picker:
`ProjectStore` filtered on `user_id = $2 OR is_admin`, so an admin's list
returned the whole org. Projects are now strictly owner-scoped across
`list`/`get`/`update`/`delete` — even an admin sees and touches only his own
projects (store signatures take `user_id: Uuid` instead of `&UserRow`).
Side effect by design: an admin can no longer bind his chat to another
user's project (chats.rs / gateway.rs project fetches are owner-scoped too).
Store test asserts admin isolation explicitly. Note chats themselves keep
their own admin-bypass shape — only projects changed.

## WSL execute failures on systemd distros: interop self-heal — 2026-09-20

maintainer: WORKSTATION (Windows 25H2 + WSL 2.7.10, archlinux distro, systemd=true)
failed every `execute` with `exit 127 — /mnt/c/.../WindowsApps/wsl.exe: 1:
MZ: not found` — intermittently for days (fails 09-17/09-19, working
windows between). Root-caused live against the machine: WSL's interop
binfmt entry (`/proc/sys/fs/binfmt_misc/WSLInterop`) goes missing on
systemd distros (microsoft/WSL#8843 family: wiped by systemd's early
binfmt_misc mount dance, not re-registered — systemd-binfmt.service's
conditions are unmet so nothing restores it — and reaped again by WSL's
session lifecycle; manual re-registrations vanished within minutes while
the VM stayed up). With the entry absent, the login-shell session
(`wsl.exe --exec bash -lc`) bootstrap execs `wsl.exe` through the broken
interop, a POSIX shell falls back to reading the PE image as a script and
dies on the `MZ` magic — exit 127 before the command runs. Non-login
direct execs (`--exec base64`, the fs-tool transport) keep working, which
is why read_file survived while execute died in the same minute.

Fix, two layers. (1) `guild-core/src/tools/shell.rs`: the WSL branch now
detects the signature (exit 127 + `MZ` in stderr), re-registers the entry
via `wsl -u root --exec sh -c` (non-login — the transport that still works
while broken), and retries the command once (the failed attempt never ran
the command, so no double-execution risk); heal is rate-limited to one per
30s and the outcome lands in `meta.wsl_interop_healed`. (2) Machine-side,
installed on WORKSTATION now: `wsl-interop-heal.timer` (5s) +
`/usr/local/sbin/wsl-interop-heal.sh` re-register the entry whenever
missing; execute verified working again via an API-driven probe
(PROBE_CATCH/FINAL_VERIFY_OK). Shipped to all machines as **0.5.12**
(release-clients.sh, all four platforms published; the WORKSTATION updater
picks it up on its 15-min re-check). The release build exposed two
post-0.5.11 breakages in the rewritten history, both fixed: `winreg` was
left in the desktop crate when machine_link.rs moved into the daemon
(guild-app-server never compiled for windows since), and the desktop
crate was never recompiled after the auth-state refactor (Session.cloud
→ Session.auth.cloud).

## Specs folded into PRD + SRS; binding model implemented — 2026-09-19

maintainer: all change-set specs are consolidated into one PRD + SRS set with
no historical trajectory (git history is the record); `docs/specs/` is
deleted, lane reports retired. `docs/PRD.md` carries 28 numbered product
requirements; `docs/SRS.md` carries 55 numbered system contracts verified
against the code (SRS-10…13 are the binding model). The binding-model
decision is now code: `CreateChatRequest` lost `machine_id` (serde ignores
the field for old clients — no breakage), the create-time auto-bind and the
per-chat machine endpoint are gone, the workflow's sandbox fallback is
`machine_id.is_none()` (desktop-origin projectless chats sandbox-execute;
`origin_machine_id` is audit metadata only), migration 0053 clears machine
bindings on unbound chats, project unlink clears the binding, and the
desktop pill/offline banner render only on project-bound chats. Two docs
follow code where old specs lied: project names are not unique (migration
0050 dropped the constraint), and integration adapters are the unified
PluginTurn/MCP-pool shape (no ToolAdapter trait exists). Full suite green
(guild-server 335, protocol 9, guild-app-server 50, desktop 121 + tsc);
redeployed.

## Decision: machine binding is project-derived — the "machine-bound, no project" state dies — 2026-09-19

maintainer: a chat is either project-bound (project → machine + folder, the
folder is the workdir) or fully unbound; no third state. Desktop-origin
chats with no project stay unbound — the desktop is just a GUI for unbound
chats, and their tools run in the server-side sandbox executor, never
auto-dispatched to the sending desktop. Recorded as §7 in the unification
spec, with amendments in the machine-registry and projects-wsl specs.
Implementation scope when picked up: delete `CreateChatRequest.machine_id`
+ the per-chat machine endpoint (protocol change → bindings regen), delete
the create-time auto-bind (http/chats.rs) and the workflow's
origin-machine auto-bind branch (restate.rs — sandbox-fallback condition
becomes "no project"), drop `machine_id`/`machine_label` from unbound chats
(migration + project-unlink clears the binding), pill/offline-banner only
on project-bound chats (WebChat), update the auto-bind tests (chats.rs,
projects_api.rs, funnel dispatch tests' workdir fixtures).

## Architecture deepening round: executor funnel + GenerationTable, thread-reducer, rider cleanups — 2026-09-19

maintainer accepted the r3 architecture-review suggestions and had them
implemented via three parallel Herdr lanes (reports:
`docs/reports/2026-09-19-arch-deepening-{funnel,riders,reducer}.md`).
Server lane (4 commits): `GenerationTable` in state.rs — the per-chat
streaming map is private behind verbs, and `take_buffers_for_capture` turns
the feed.rs capture-atomicity comment into code (pinned by a
`capture_during_commit_never_shows_a_step_twice` test); new
`worker/funnel.rs` owns suspend→dispatch→watch→resolve for all executor arms
behind two ports — `funnel::suspend(ctx, …, Executor)` where `Executor` is
the spec's taxonomy as a type (`Desktop`/`Sandbox`/`ServerLocal`), and the
transport side calls `complete`; the three arms in restate.rs collapse to
thin suspend calls; new `worker/turn.rs` carries the turn derivations
(`build_turn_text`, `load_media_map`, `media_parts`, `enforce_quota`) so
restate.rs imports nothing from http::gateway and gateway.rs went 1671 → 993
lines. Desktop lane: `apps/desktop/src/lib/thread-reducer.ts` is the single
source of the visible-block merge rules (holds state, exposes
`applyEvent`/`applyFrame`/`reconcileSend`/`setCompacting`; every `setBlocks`
site routed through it; per-bug-class tests incl. the 0.5.10 compaction-flash
guard, now reducer data instead of a component conditional). Rider lane:
`run_agent` and its loop types deleted from guild-core (loop-level tests
gone; `agent::policy` kept); `chat.send` rides the shim's drive path
(`drive_chat` in agent_start.rs) — the second completion loop is gone;
new `auth_state.rs` owns token.json + machine identity + link publication
(mutate ⇒ persist ⇒ publish is one `transition` method; login / pair /
identify / session.clear are thin; `tool.run` retired — no callers).
Merged funnel→riders→reducer; full suite green on master (guild-server
119 lib + all integration suites, guild-core 76, protocol 9,
guild-app-server incl. engine_stdio, desktop 121 + tsc).

## Phase 5 landed: web parity — machine-mediated AGENTS.md + sandbox executor — 2026-09-18

Both completions of the unification spec §4 phase 5 are in:

- **5a** — when a turn arrives with no client-assembled AGENTS.md chain
  (browser tab) and the chat runs against a bound project, the workflow
  dispatches ONE read_file for the project's AGENTS.md through the machine
  channel before the system prompt is built (same durable dispatch shape as
  client tools, minus gates/events; 30s durable timeout, offline → turn
  proceeds without it). Freshness is a TTL cache per project folder
  (10 min, in-memory) — the machine channel has no mtime verb, so the
  spec's "per project + mtime" resolves to a bounded TTL.
- **5b** — a web chat with nothing bound (no machine, no desktop origin)
  falls back to the **sandbox executor**: the same tools run server-side in
  a per-chat `data_dir/sandbox/{chat_id}`, behind the same static exec
  policy and interactive approval gates as client tools (web client answers
  approvals like any other executor). A bound-but-offline desktop keeps its
  explicit message — the user's workspace is on that machine, not the
  sandbox. No API or protocol change: the fallback is derived, and the
  served UI now declares tools for browser clients too (`client_tools:
  true`).

Verified live on :18080: 5a — browser-style turn on a project-bound chat
pulled AGENTS.md from the daemon machine and the model obeyed its
instructions; 5b — a no-binding chat executed write_file server-side into
the per-chat sandbox dir. The unification spec (§4) is fully implemented:
phases 1–5 all landed (1a 34a48fb, 1b 7dd203c, 2 aabf8af, 3 4f4f89f,
4 74fdfb3, 5 this commit).

## Phase 4 landed: B2 re-homed onto the durable gateway workflow — 2026-09-18

Server workspace sessions (`/api/v1/agents/sessions`) no longer run
`run_agent` in-process; a turn submits the same `ChatRunner` workflow every
gateway chat uses, with `ChatCompletionRequest.server_workspace` naming the
org workspace the **server itself** executes tools in (never a client path —
resolved server-side under `workspaces/{org}/{name}`). Execution is a
journaled workflow step (`server_local_tool_step`): guild-core fs tools +
shell-when-allowed, static exec-policy gate on `execute`, no interactive
approvals (batch contract), ToolStarted/ToolCompleted streamed with
`executor: Server`. The agents HTTP API became submit + poll (JSON ack
`{accepted, generation_id, invocation_id}`; history is the thread journal);
the gateway turn-submission core was factored out as
`gateway::submit_turn` shared by both callers. Verified live on :18080:
write_file executed server-locally into the workspace dir, execute denied
with `allow_shell_tools` off. In-repo test asserts the submission contract
(mock restate ingress); deep behavior is the live E2E, like every gateway
workflow path. Phase 5 next: web-parity completions (5a AGENTS.md for web
chats, 5b sandbox executor on the new server-local mechanism).

## Phase 3 landed: the thin desktop backend contract — 2026-09-18

The desktop backend now matches spec §3 exactly (4f4f89f): executor +
fs.* bridge + registry crypto + CLI auth store, nothing else. Session
message mirroring removed (the thread journal is the only history);
agent.start takes caller-assembled context (verified live — markers ride
into the server prompt); skills.rs/agents_md.rs deleted (registry client
kept the sidecar types it needs). The single-process merge itself was
already in (2026-09-13 spec). Phase 4 next: re-home B2 (server workspace
sessions off run_agent), then phase 5 web-parity completions.

## Phase 2 landed: context assembly is client-side — 2026-09-18

Skills discovery/index, `/name` expansion, and the AGENTS.md chain moved
from the daemon to the webview (aabf8af): `apps/desktop/src/lib/context.ts`
ports the Rust logic to the letter (16 vitest tests), backed by the new
allowlisted `fs.*` RPC bridge (read: project + git-root chain + config dir
+ ~/.agents; existence probes above the roots answer `.git` discovery
only; writes: config + project; symlinks resolved eagerly, `..` escaped
normalized). Daemon verbs skills.list/prepare_turn/disable removed; the
engine shim keeps Rust-internal discovery until phase 3. Server rebuilt,
bundle live. Phase 3 next: merge the daemon into the Tauri host (one
binary: executor + fs bridge + registry crypto + CLI auth).

## Phase 1b landed: agent.start is a gateway shim — 2026-09-18

Loop B1 is dead (7dd203c): the daemon's `agent.start` drives the durable
gateway workflow and maps StreamEvents → agent.* events
(`agent_start.rs`); approvals ride the journal via the approvals endpoint
(agent.approve → HTTP POST). Machine-bound projects are find-or-created
by the shim; tools dispatch to the daemon's own machine link. Found +
fixed a real reconnect deadlock in the link's shutdown tail (Close sent,
sender never dropped → writer.await hung → no reconnect after any
healthy-socket break; machine "offline" while the daemon looked alive).
Live E2E: identify → agent.start → tool dispatched → daemon executed →
result + done. Engine users now have integrations, exec policy,
durability, journal history. No server changes — ships with the next
desktop client release.

## Phase 1a landed: the daemon owns the machine link — 2026-09-18

maintainer approved the unification spec
(`docs/specs/2026-09-18-agent-loop-unification-design.md`); phase 1a shipped
(34a48fb): the daemon now owns the machine's executor connection
(`guild-app-server/src/machine_link.rs`) — machine WS + ToolDispatch
execution + identity persistence in token.json (survives restarts, works
with no GUI open). New `machine.identify` RPC; webview reports its id after
auth. The Tauri host's WS is member-only (frame delivery; its execute path
deleted). TDD throughout (10 new tests); fixed two latent bugs en route:
rustls provider never installed (dual ring/aws-lc-rs in tree → connect
panic) and test-template databases not role-scoped (two roles on the host
PG collided on clone). Verified live E2E on :18080: link registered,
workflow dispatched read_file, daemon executed, result flowed. Installed
desktop clients keep old behavior until the next release (single binary).
Phase 1b next: agent.start → gateway-workflow shim (kills loop B1).
Server rebuilt; frontend lives on :18080.

## Tool artifacts: large tool results spill to object storage + materialize on the client — 2026-09-18

maintainer: oversized server-tool results no longer truncate or bloat history.
One primitive (spec `docs/specs/2026-09-18-tool-artifacts-design.md`): a
result over 64 KiB — or a tool that carries an `artifact` payload (new
`ToolOutcome.artifact {filename, content_type, bytes}` on both the
guild-core and integration shapes) — is spilled into `tool_artifacts`
(migration 0052: row in Postgres, bytes in rustfs, cascade on chat,
no cleanup yet — TODO). `ThreadEvent::ToolResult` gained optional typed
`artifact_id`; spilled content is a pointer line + 2 KiB head excerpt
(binary mime: path + size + mime only) with meta.card
`{card:"artifact", id, filename, content_type, size_bytes, path}`.
Replay-safe: the spill rides the journaled tool run and creation is
idempotent (uuid v5 over chat_id+call_id, INSERT ON CONFLICT DO NOTHING).
Endpoints: `GET /api/v1/tool_artifacts/{id}` (org-scoped bytes) and
`GET /api/v1/chats/{chat_id}/tool_artifacts` (list). The model addresses
`.guild/artifacts/<chat_id>/<filename>` — a real workspace path, shell
compatible; guild-core gained the artifact path contract + index +
touch-time materialization hooks, and app-server materializes on first read
(explicit "not materialized; will be fetched when online" error text),
prefetches in the background on both agent start (thread-log sync) and live
ToolCompleted frames. Desktop renders an artifact download card on spilled
tool_result frames (authed blob fetch mirroring attachments, retry).
google_workspace: `api` cap 12K → 1 MiB (spill now protects history),
`gmail_get_message` lists attachment parts, new `gmail_get_attachment`
decodes base64url and hands bytes through the artifact channel — the
patents XLSX case that motivated this lands as a real file. Local tools
keep their inline caps (their output already has a local copy).
Delivered by three parallel Herdr lanes (server / client / UI) on separate
worktree branches, merged server→client→UI; bindings regenerated, full
suite green (`guild-server --features test-support`, `guild-core`,
`protocol`, `guild-app-server`, desktop tsc + WebChat tests).

## Architecture decision: one agent loop + thin desktop backend — 2026-09-18

maintainer decided the target architecture; spec at
`docs/specs/2026-09-18-agent-loop-unification-design.md`. The durable
gateway workflow becomes the only agent loop (engine `agent.start`/B1 is a
shim to it; `run_agent` dies with its last caller); the desktop Rust
backend shrinks to an executor (machine tools via the machine WS —
already how the Tauri host works), a primitive allowlisted file bridge,
registry crypto, and the auth store; TS owns all interaction + context
assembly (skills index, `/name`, AGENTS.md). Web/desktop parity is an
executor taxonomy: web gains agentic power via a future server-side
sandbox executor, never via a second loop. Phased migration in spec §4;
phase 1 (B1 shim) is the first buildable step. No code yet — spec only.

## AGENTS.md loading + skills parity with Codex — 2026-09-18

maintainer: chats bound to a project now load project instructions exactly like
Codex (to the letter, per codex-rs `core/src/agents_md.rs`). Discovery runs
in the desktop daemon where the files live (`guild-app-server/src/agents_md.rs`):
global `{config_dir}/AGENTS.override.md` → `AGENTS.md` (first non-empty), then
the project chain from the git root down to the project folder (inclusive),
one file per dir (`AGENTS.override.md` beats `AGENTS.md`), empty files skipped,
32 KiB shared budget with per-file truncation; global→project transition uses
Codex's `--- project-doc ---` separator. Rides a new additive `agents_md`
field on `ChatCompletionRequest` (same pattern as `skills_index` — the client
never owns the system prompt); the server renders Codex's user-instructions
fragment (`# AGENTS.md instructions for <folder>` + `<INSTRUCTIONS>` markers)
into the system prompt before the workspace sentence, capped server-side at
32 KiB. Wired on both paths: `agent.start` engine sessions (assembles for the
session's project dir) and `skills.prepare_turn` (new optional `project_dir`
param; no project → global only). Desktop resolves the picked project's folder
(PickedProject now carries `folder`) and passes both fields through.
Browser (non-Tauri) chats unchanged — no local files, as with skills.
Tests: discovery unit tests (order, override, empty-skip, budget, no-git),
system-prompt rendering/cap tests, engine_stdio + gateway_api green. Also
fixed pre-existing migration-test counts (50 → 51, stale since 0051_archive).
Server rebuilt; frontend lives on :18080.

## Sidebar rows: hover kebab menu — rename + archive; 0.5.12 server — 2026-09-18

maintainer: a hover-only button on every sidebar row (chat rows in Recents and
project fold-outs, and project rows) opening Rename/Archive; hover-only via
opacity (absolutely positioned, zero layout shift); rename edits inline
(Enter/blur saves, Esc cancels). Archive is a soft-hide per his choice:
`archived_at` on chats and projects (migration 0051), lists exclude archived
rows, direct links still resolve, unarchive stays API-only. New
`PATCH /api/v1/chats/{id}` ({title, archived}); `PUT /api/v1/projects/{id}`
gained `archived`. Store tests cover rename/archive/filtering + foreign-member
404. Server rebuilt; frontend lives on :18080.

## Sidebar truncation fades, count badge removed; 0.5.11 clients — 2026-09-18

maintainer: remove the red project-count badge in the Projects sidebar, and
truncate by shading, not "…". The badge (plus the WORKSTATION machine pill on
project rows) is gone; the project rows already shaded via `FadeTitle` and
the composer project chip now does too (both chip variants; the label
measures overflow with a ResizeObserver and masks the last ~22px with a
to-transparent gradient when it overflows — no ellipsis anywhere on these
surfaces). Server rebuilt and live on :18080; 0.5.11 clients released on
all four platforms, updater manifest serving them.

## "Compacting thread…" flash on the first send; 0.5.10 — 2026-09-18

maintainer's screencast caught it: the optimistic "Compacting thread…" line
rendered for ~1.5s under the pending first message of a brand-new chat. The
render guard was `compacting === chatId`, and while the chat is still being
created both are null — `null === null` holds, so every initial send flashed
the compact line for the create round-trip. The guard is now
`compacting !== null && compacting === chatId`. Server rebuilt (browser UI
live on :18080); 0.5.10 clients released on all four platforms, updater
serving them — the desktop app needs the 0.5.10 auto-update to pick the fix
up.

Side finding while reproducing: the member socket's session watcher treats a
>2s DB hiccup as auth failure (ws.rs `session_valid` → AuthRequired → the
tab logs out spuriously). Left as-is; worth hardening if it shows up again.

## Sidebar: project rows are fold-outs, Recents never filters — 2026-09-18

maintainer call: selecting a project must not filter the thread list. Recents
always shows every chat; a project row toggles an inline fold-out listing
that project's chats (they intentionally duplicate Recents rows). The
fold-out opens with the latest 5 chats and a "Show more" row at its bottom
adds 20 per click. The `/project/<id>` route filter is gone from the
sidebar (`activeFilterId` removed; the route still parses harmlessly).

## /compact: in-thread progress + busy thread — 2026-09-18
The `/compact` toast is gone. The composer command now appends an
optimistic in-thread line ("Compacting thread…", spinner) that clears when
the durable `Compaction` event lands through the thread sync — at which
point the collapsed card reads "Context compacted". While the server-side
compaction runs, the `compact` ChatRunner handler holds the chat's
generating flag (journaled, cleared on every exit), so the thread reads
busy — sidebar spinner, sends queue behind it — same as a turn. A failed
compaction appends nothing to the log; the client reconciles on the busy
flag dropping back to false without a new compaction event.

The compaction card no longer shows the icon or the model name — the
header reads just "Context compacted". Desktop 0.5.9 released all four
platforms, updater serving it (token minted in Postgres, revoked after).
The release ran from a throwaway worktree at the release commit: a sibling
session's in-flight edits in the main tree broke `tsc` mid-build.

## External links; stop watcher for suspended tools — 2026-09-18

Taken over from an idle session (already deployed and exercised live):

- **External links** open in the user's browser, never navigate the app
  window (a plain anchor navigation would load the URL inside the Tauri
  webview). `@tauri-apps/plugin-opener` registered in the desktop shell;
  markdown content and attachment links route through an `openExternal`
  helper (opener plugin under Tauri, `window.open` elsewhere).
- **Stop watcher**: while a client tool is suspended, a watcher polls the
  chat's cancel flag; a stop resolves the pending tool immediately with an
  interrupt notice (durable `complete_tool` funnel), so the turn ends at
  its next journaled cancel check instead of waiting out the executor or
  the 5-minute timeout.

## 0.5.8: popup fixes — 2026-09-18

Two callouts from the first live look: the `/` popup rendered statically on
an empty composer (mentionMatches fell back to an empty query when no token
was open — every command listed) and the self-evident keybinding hint bar
was noise — both fixed. Server rebuilt, new bundle live; 0.5.8 released all
four platforms, updater serving it.

## 0.5.6: /compact command; skills as slash commands in chat — 2026-09-18

The composer's `/` autocomplete now round-trips. `/compact` (exact match)
triggers the manual compaction endpoint instead of a turn — feedback via
toast, the card lands through the thread sync; while generating the server's
rejection surfaces as an error toast. Skills: a new `skills.prepare_turn`
engine RPC expands `/name` mentions with the full SKILL.md body and renders
the skills index — the gateway path's counterpart of the engine's send
expansion (until now the token reached the model as plain text with no
index); chat sends carry `skills_index`, and user turns strip the
`Invoked skills` block at render (the marker joins `\n\n[Attachment: ` as a
client strip boundary; model-facing history keeps the body). Browser mode
has no local skills and sends the prompt through untouched. Desktop 0.5.6
released all four platforms, updater serving it; server rebuilt, new bundle
live.

## Desktop 0.5.5 released (stop/queue/steer reaches installed clients) — 2026-09-18

`scripts/release-clients.sh` VERSION=0.5.5, all four platforms published
and sha256-verified (windows NSIS setup, linux AppImage, darwin .app.tar.gz
updater artifacts for both arches); `updates/latest.json` serves 0.5.5 with
tauri signatures, so existing clients auto-update. Session token for the
publish minted directly in Postgres and revoked after (the standing recipe).
Server itself already ran the feature (same-day deploy). Pending: devbox's
raw-exe manual copy (`AppData/Local/Guild/guild-desktop.exe` — its installed
layout bypasses the NSIS updater) — devbox unreachable over SSH at release
time; new exe staged at
`target/x86_64-pc-windows-msvc/release/guild-desktop.exe`.

## Stop, queue, steer — turn control for the chat — 2026-09-17

Three missing chat controls, all server-owned (maintainer request): **stop**
(`POST /api/v1/gateway/chat/{id}/stop`) interrupts the running turn and the
delivered prefix stays in history; **queue** (default when sending while a
turn generates) commits the user turn to the thread log immediately and the
running turn flushes it at its exit; **steer** (`send_mode: "steer"` on the
send) queues the message AND requests the interruption, so it runs right
after the interrupted prefix.

Mechanics. `ActiveGeneration` carries an in-memory cancel flag; every cancel
decision in `ChatRunner::generate` is read INSIDE a journaled step (per-chunk
check in the streaming model call + a step-top check), so the interrupted
turn's shape is a journaled output and replays deterministically — the flag
itself is volatile: a process crash mid-turn forgets the stop request and the
turn continues (the user can stop again). The interrupted prefix persists as
an `interrupted` assistant event (same guards as the failure path; tool calls
already dispatched run to completion — cancel takes effect at the next step
top; a turn suspended on an approval card waits for that answer first, deny
the card to release it early). A queued send commits its `user_message` event
from the gateway (with document text inlined and route-modalities-shaped
notes) plus a `chat_queue:{chat}` kv record carrying the queued request's
turn parameters (model, client_tools, machine/project binding) — the flush
invocation is an empty-turn `generate` background call the finishing turn
sends to itself, delivered when the object lock frees; the flush derives the
model history from the log (queued events ride automatically) and clears the
kv on consume. A flush with nothing queued bails silently (dedupes the
race where the finishing turn's flush and the queue fall-through both fire);
the generating flag clears unconditionally at every successful exit and the
flush re-sets it (a flush failing before its own flag-set must not inherit a
stuck spinner). Failures do NOT auto-flush — a queued message after a failed
turn stays in history and flows into the next turn. Client: the composer
stays usable while generating — Enter queues, Ctrl/Cmd+Enter steers, and
with an empty composer the send button becomes Stop; interrupted turns show
a muted "stopped" marker on the delivered text. Tests: `chat_control.rs`
(queue commit, steer flag, stop endpoint/idle-409), pure tests for
`has_queued_user_turn`, old-journal `stopped`-default parsing, and the
interrupted-marker derivation; desktop vitest 79/79, tsc + vite clean.

## Projects + WSL shipped — per-chat folders deleted, thread data wiped — 2026-09-17

Spec `docs/specs/2026-09-17-projects-wsl-design.md`, plan
`docs/plans/2026-09-17-projects-wsl.md`; three implementation lanes merged
on `projects-wsl` (server, guild-core, desktop), review round 1
(security + correctness) in `docs/reviews/2026-09-17-projects-*r1.md`.
Decisions (maintainer, interview 2026-09-17): Codex-style project model
(project = name + one folder + owning machine; server-side table; sidebar
Projects/Recents; project optional per chat; per-chat folder mechanism
deleted outright — no migration of old state, thread data wiped: chats,
thread events, chat reads, attachments, agent sessions, chat-keyed kv, and
the Restate container state at deploy). WSL: a distro is a folder source on
its Windows machine (`\\wsl.localhost\…`), not a machine of its own;
distro list hides `docker-desktop*`, lists stopped distros (auto-start on
pick); shell tool runs `wsl.exe -d <distro> --cd <inner> --exec bash -lc
<cmd>` (login shell, default user only); file tools route through wsl.exe
(base64 read, stdin-piped `cat >` write, host-checked `mkdir -p`), never
the 9P share; the exec-policy gate classifies the model-written raw command
(the wsl.exe wrapper is added at spawn inside guild-core) and model-written
`wsl` gets a documenting Prompt rule. Folder delivery is server-owned:
`ToolDispatch` carries `workdir` from the project row — the volatile
app-process chat→dir map, `set_chat_dir`, and the `guild.dir:*` localStorage
keys are gone. Project binding sets the chat's machine (chats inherit; the
per-chat rebind endpoint stays as an override) and is fixed at chat start —
the composer chip is interactive only on a new (unsent) chat; existing
chats display their project read-only (maintainer, 2026-09-17). Skills/registry sections
resolve their aim folder from the projects API ("most recent chat's
project, else first project"). Desktop 0.5.0 released (all four platforms,
sha256-verified; devbox manual exe copy), compose stack rebuilt, Restate
state wiped at deploy. Review round 1: no blockers; fix round 1 landed the
chatgen_inv kv cleanup as migration 0049, machine/project alignment at bind time,
request-wins-only-for-in-session-picks, parser-agreement pin, the `wsl`
policy rule, and desktop edge cases (dead filter id, new-chat filter,
blocking distro fetch, `~` without home, ThreadState project fields
consumed). Known follow-ups: remote-machine folder browsing (same
folder-source shape), skills discovery through wsl.exe, optional `list_dir`
scoping hardening, edit_file non-atomic (accepted, commented).

## Thinking frames survive republishes; no inner scroll — 2026-09-16

While a turn generates, the feed republishes the open chat's ThreadState
roughly every 100ms (buffer-length signature check), and the client rebuilds
all blocks from durable events. The in-flight thinking text is not a durable
event yet, so `upsertThinking` appended it as a fresh block with a new
`liveKey()` on every publish — the `ReasoningFrame` remounted ~10×/s and its
`open` state reset, so clicking the header to expand was undone within the
next publish ("can't expand while it generates"). The seed block now takes a
caller-chosen deterministic key (`live-thinking-<chat_id>`), so the frame
instance and its expanded state survive every republish; a step boundary
replaces it with the persisted event's stable seqKey block as before.
Also removed the `max-h-64 overflow-y-auto` inner scroll on the frame body —
large thinking blocks now render at full height in the conversation flow and
the pane's own scroll owns the page. Pure test added (key stable across
publishes); desktop vitest 28/28, tsc + vite clean; compose server rebuilt
and serving on :18080. Note: packaged desktop clients pick this up only with
the next client release.
## Approval cards can no longer hang — every decision settles observably — 2026-09-16

A stale approval card (its turn ended before the card was answered) used to
hang forever in the client's optimistic state: the decision endpoint
forwarded to `complete_approval`, the handler saw no `approval:{call_id}`
state key, no-oped silently, and no `ApprovalResolved` frame ever came. The
decision endpoint now settles every path observably:

- **Recorded decision** (any earlier answer, or the 5-min timeout auto-deny):
  echoed verbatim from the thread log; the ChatRunner is not contacted. Late
  clicks are idempotent and settle their card from the POST response.
- **Live turn**: forwards as before (`settled: false` in the response); the
  gate journals the decision and broadcasts the resolved frame.
- **Orphaned call** (no recorded decision, no live turn): journals an
  `expired` decision (`ThreadEvent::ApprovalDecision.expired`, serde-defaulted
  false on old events) and still forwards — a gate suspended in Restate after
  a server restart accepts the decision even though the in-memory generation
  registry is empty. Response settles the caller's card immediately.

The new `expired` state is truthful, not a retroactive rejection: the turn
already got its answer, the call can never execute. Expired cards stay
visible in history (no tool result tells their story); approved/denied cards
are still dropped as decisions-not-content. The client's card gains a muted
`expired` pill, settles directly from the POST response when `settled: true`,
and re-enables 15 s after a click that got no answer (retries are idempotent).
Tests: `recorded_decision_is_echoed_verbatim`,
`orphaned_decision_is_journaled_expired` (approval_api.rs), expired-card
history derivation (WebChat.pure.test.ts).

## Machine `execute` is gated by static prefix rules first — 2026-09-16

The chat's approval flow has a static layer in front of the judge, the same
shape as codex's: Starlark prefix rules (vendored `codex-execpolicy` crate)
classify every machine `execute` call before the approval gate. An `allow`
rule runs the command with no gate and no judge; a `forbidden` rule is a
hard deny whose text is the rule's justification (fed back to the model as
an error tool result — never a card, never an escalation); `prompt` rules
and unmatched commands go to the chat's approval mode exactly as before
(approve_for_me judge / ask card / full access). Commands are shlex-tokenized
and split at `&&`/`||`/`;`/`|`; every segment is evaluated independently and
the strictest decision wins; any segment containing a shell redirection is
never auto-approved.

An `allow` decision skips the interactive gate entirely (the deny/prompt
branches wrap it); the wrapped `if` keeps the awakeable dispatch outside.

Rules live in `crates/server/assets/exec_policy_*.rules` (a small curated
base + a layer extracted from a local codex install) and are parsed by the
crate's Starlark parser at BUILD time (guild-server build.rs emits plain
JSON into OUT_DIR; the runtime reconstructs the policy without linking
`starlark`). The indirection is load-bearing: starlark enables
`serde_json/arbitrary_precision`, a cargo-global feature that breaks
internally-tagged serde deserialization of numeric fields across the whole
binary — every StreamEvent frame parse failed while it was linked.

## Skills system (agent-facing half) — 2026-09-16

The registry half (publish → review → install) existed, but `agent.start`
passed `system: None` — no skill ever reached the model. Implemented per
`docs/specs/2026-09-16-skills-design.md` (modeled after Codex):

- **Loading**: `agent.start` discovers skills from the shared harness dirs —
  repo `.agents/skills` (cwd→git root), user `$HOME/.agents/skills`, legacy
  `{project}/.guild/skills` + `{config}/guild/skills` (read-only fallback) —
  merges by name (project wins), drops paths disabled in
  `{config}/guild/settings.json` (`"skillsDisabled": {"<path>": false}`),
  and renders the index into the prompt (8k-char budget: shorten
  descriptions, then drop with an omission notice).
- **Transport**: the system prompt stays server-owned. New additive
  `skills_index` field on `ChatCompletionRequest` → forwarded through
  `ChatRunPayload` → appended to `build_system_prompt` and hard-capped
  server-side (8k) — the server is the enforcement point.
- **`/name` invocation (composer autocompletes on `/`)**: `/slug` tokens at
  word start (URLs/paths don't fire it) matching a discovered skill append
  the full SKILL.md body to the turn message; unknown tokens pass through.
  The desktop Settings has a Skills section (skills.list / skills.disable
  JSON-RPC) with provenance badges, a disable toggle, publish (versioned,
  stamps the sidecar) and uninstall; the Registry section installs skills.
- **Install/uninstall**: registry installs land in `.agents/skills/<slug>`
  (repo scope, or home with `global: true` on `registry.install`); new
  `registry.uninstall`. Every Guild install/publish writes an
  `agents/guild.yaml` provenance sidecar (source/slug/version/publisher/
  review status/bundle hash); uninstall refuses dirs without a
  `source: registry` sidecar, so codex/pi-authored skills are never deleted.
  Publish stamps the author's dir with `published_by_me: true`.
- TS bindings regenerated; tests: skills unit tests (scopes, budget,
  sidecar, mentions, disable list), restate prompt-cap test, registry_client
  roundtrip extended (sidecar, uninstall, refusal, publish stamping).
  Desktop UI (uninstall button, provenance display, `$` autocomplete) and a
  full cloud skill runtime are future work.

## Unset approval mode resolves to Approve for me — 2026-09-16

The composer trigger on an unset chat showed a literal "Default" — a mode
the popup doesn't offer. Two fixes: the server now resolves an unset chat
mode the same way as `approve_for_me` (AI judge) when no account policy is
stored, and the trigger label shows the resolved account default (fetched
once from Settings → Approvals: ask → "Ask for approval", allow → "Full
access", never → "Deny all", unset → "Approve for me") instead of the
phantom "Default". An explicitly stored account policy still wins over the
judge, so Settings per-tool overrides stay meaningful; per-tool `always_ask`
curation still forces the card. "Server default" hint in Settings updated
to match.

## Tool labels keep the connector slug — 2026-09-15

Every built-in connector exposes an escape-hatch tool named `api`; wire names
are slug-namespaced (`atlassian_api`, `gitlab_api`, …). The chat used to
strip the connector prefix from every label, so all connectors rendered as a
bare ambiguous "api" while the approval card below showed the raw namespaced
name — and the stripping rested on the assumption that connector tool names
are self-describing without their slug. Fixed by dropping the assumption:
`toolDisplayName(name)` is the single label source for tool frames and
approval cards and keeps the full namespaced name (underscores become
spaces: "atlassian jira search", "gitlab api"); only the dead legacy `int_`
marker is stripped so old journals render like new ones. Top-level client
tools still render by kind ("Web search", "Browse") regardless of provider.
Pure tests added in WebChat.pure.test.ts; desktop 20/20 pass; compose stack
rebuilt and serving on :18080.

## In-progress state survives thread switches — 2026-09-15

Reopening a running thread showed an idle composer while the sidebar
spinner kept spinning. The window's `busy` is per-view state; the
switch-away re-sync read the app-process mirror, which still says idle when
the switch lands before the turn's first fan-out frame — and live frames
only cleared busy (done/error), never set it. Fixed three ways: a live
fan-out frame for the open chat restores busy; `streaming` also derives
from the open chat's server-side `generating` flag (the same truth the
sidebar shows, via chat-status frames / optimistic send / fetched list);
on web, switching away mid-send clears the global busy instead of pinning
it forever (the reattach watcher + chat-status frames own the state from
there).

The switch-back replay duplication is fixed too: the desktop mirror holds
every frame since the turn started, while the thread reload restores the
persisted steps — replaying both rendered a completed step's text twice.
Everything up to the last completed tool call is durable (tool results
persist before their completion broadcasts), so the replay trims to the
in-flight step (`replayFrom`). Tool-start frames now upsert by call id
instead of appending (a persisted call re-served by the replay or the
attach endpoint no longer renders twice), and the reattach thinking seed
starts a new reasoning block instead of overwriting the previous step's
thinking.

## Curation fix round 1 (reviewer + verifier findings) — 2026-09-15

Both round-1 agents (review + verify) found the same headline bug and the
round fixed it plus everything actionable:

- **always_ask now wins (C1)**: `approval_gate` takes `force_ask`; a tool
  curated `always_ask` gets the durable card ahead of the chat's approval
  mode (full_access/approve_for_me included) and the user's policy.
- **Curation writes are row-locked (I3)**: `set_integration_tool` does
  SELECT … FOR UPDATE → merge → UPDATE in one transaction; concurrent PUTs
  serialize. The stored tools map additionally has a storage-layer
  guarantee: `integrations.upsert/update` preserve the CURRENT row's
  `tools` key (SQL-side `jsonb_set`), so a settings save racing a curation
  write cannot drop the newer entry either.
- **The stored tools map has one writer (I4)**: settings saves strip a
  client-sent `tools` map (stale snapshot) and carry the stored selection —
  built-in and MCP paths both.
- **Script API refuses always_ask tools with 403 (I5)**: it is
  non-interactive — no durable card exists there, so refusing is the
  fail-closed reading of spec §6. Fixed en route: the raw-connector-name
  path matching (it never actually matched — both sides now compare after
  namespace stripping).
- **Template lock is real (I1/I2/M5/M6)**: lock/sweep/build/unlock run on
  one dedicated pooled connection; orphan build DBs swept every call; clone
  retries once after re-ensuring; stale-name DDL guarded by a charset check.
- **Durable audit (I7)**: curation changes emit `integration.tool_curated`
  to the org event log (asserted in tests).
- **UI (I6)**: the Tools table shows fetch errors + Retry instead of an
  endless skeleton.
- **Minors**: dead `tool_curations()` removed; PUT tool-name charset now
  accepts `-` and `.` (MCP names); single resolved-target refactor in
  `server_tool_step` (M2); MCP turn-start connect-before-filter trade-off
  documented (M4).
- Tests: tool_curation.rs now 7 (added: client-sent tools map cannot
  overwrite curation, durable audit event, member 403 on GET+PUT, script API
  always_ask → 403). Known gap: no workflow-level always_ask test — no
  ChatRunner/Restate test harness exists (tests are endpoint-level); the
  force_ask short-circuit is 3 lines and both round-2 agents re-review it.
- Operational note: after this ships, pre-existing MCP integrations serve no
  tools until an admin curates them in the Tools table (fail-closed default,
  one-time re-confirmation).

## Per-tool admin curation (adapters spec §5/§6, phases 3–4) — 2026-09-15

Integrations now carry per-tool curation in the row config:
`config.tools[<raw tool>] = { enabled, approval: default | always_ask }`.
Defaults (one rule per kind, no background writes): built-in connectors
absent from the map = enabled + follow user policy (zero-config behavior
unchanged); MCP-discovered tools absent = disabled (fail-closed — drift
lands visible-but-off until an admin enables it). Enforcement: `tool_allowed`
(now takes the turn: `tool_allowed(&PluginTurn, &PluginToolInfo, role)`) gates
the model tool list, `list_tools`, the script API, and the call path;
`always_ask` forces the durable approval card ahead of the user's policy and
the chat's approval mode (org governance wins). Admin surface:
`GET /api/v1/admin/integrations/{id}/tools` (unfiltered list; built-ins read
compiled-in declarations; MCP connects live — disabled rows report
`resolved: false` without connecting, unreachable plugins surface the error)
and `PUT .../tools/{tool}` (idempotent). Settings saves preserve the stored
`tools` map (server-side merge + UI round-trip). UI: Tools table on the
integration detail page (enable toggle + approval selector per tool; MCP rows
refresh live). Tests: `tests/tool_curation.rs` (6); the MCP fixtures in
`disclosure.rs`/`integration_tools_api.rs` now curate their tools up front —
this is the one-time re-confirmation the fail-closed transition requires of
existing MCP rows in production.

## Test speed: template-database clones — 2026-09-15

`Store::connect_test` no longer runs all 44 migrations per test database.
A fully-migrated template `test_tpl_<schema-hash>` is built once per
migration-set change (advisory-locked build, superseded templates dropped
WITH FORCE) and every test clones it via `CREATE DATABASE ... TEMPLATE`.
Per-test `connect` still verifies every `schema_history` content hash, so
drift is still caught. The stale-reaper skips `test_tpl_%`. Full guild-server
suite (230 tests): ~17–32s wall at default parallelism, stable-green;
previously ~35s+ with load-dependent flake failures.

## Requirements docs — 2026-09-15

`docs/requirements/` now holds the requirement catalog collected from all
maintainer session instructions (`requirements.md`, 77 IDs + rejected list),
high-level `PRD.md` (6 product documents) and `SRS.md` (47 FRs with a full
traceability matrix). Object storage is recorded as host RustFS (:9950);
the compose MinIO is the fallback only.

## Review loop: curation rounds 1–3 (2026-09-15) — exited CLEAN

Round 1 (review + verify on fd2ca5a) found the always_ask override
ineffective plus lost-update windows and template-lock pairing defects.
Round 2 fixed the headline items; both agents found residuals (save-vs-PUT
lost update; a self-defeating sweep guard). Round 3 fixed those at the
storage layer (config.tools preserved via jsonb_set on every
upsert/update — the PUT endpoint is the single writer). Round-3 verdicts:
reviewer CLEAN, verifier CLEAN. Reports: docs/reviews/2026-09-15-curation-{review,verify}-r{1,2,3}.md.

## Machine section copy tightened (0.3.25–0.3.26)

Per maintainer: machine binding happens on entering the device sign-in token
(pairing), not per chat — and the long "machine tools execute on the
machine bound to the chat" header explanation is unnecessary. The Machine
section now leads with just the title and the connected-machine inventory;
the single remaining note explains that machines bind at device sign-in and
appear here, with per-chat switching available from a chat. Empty state and
note reworded to the device-token flow.

## Machine settings show the inventory without a chat (0.3.24)

The Machine section dead-ended with "Open a chat to bind it to a machine"
whenever settings were opened without a chat selected — it hid the machine
inventory entirely, which read as "machine binding does not work" even
though binding itself was fine (new chats auto-bind the local executor,
machines register by heartbeat, tools dispatch). The section now always
renders the connected-machine list (the endpoint only returns fresh-heartbeat
machines, so a pulsing green dot marks them connected), with bind/unbind
controls when a chat is open and a per-chat explanation when not. The thread
header's bound-machine chip is now a button that opens Settings at the
Machine section for one-click rebinding. Desktop 0.3.24 published, installed
on devbox, both states verified via CDP.

## Approval modes adopt the codex vocabulary + "Approve for me" AI policy (0.3.23)

The composer's per-chat approval selector now mirrors codex exactly:
"Ask for approval" (always ask), "Approve for me" (only ask for actions
detected as potentially unsafe), "Full access" (unrestricted), The popup
lists exactly codex’s three modes (the extra "Account default" row was
removed 2026-09-15); an unset chat runs on the account policy.. The old allow/never
values are remapped by migration 0044 (allow→full_access; never drops the
key and falls back to the account policy — chat-level deny is gone).

"Approve for me" runs a real AI auto-approval policy: before each tool, a
model judge (the chat's own model, journaled call, 30s timeout) receives
the action JSON under an admin-tunable policy prompt and answers
{"approve", "reason"}; approve → the tool runs silently, anything else →
the usual approval card. Timeout, parse failure, or provider error all
fall back to asking (the safe direction). The policy prompt is a new org
setting (org KV `assistant_approval_policy_prompt`, admin endpoints
GET/PUT /api/v1/admin/approval-policy-prompt) shown in Settings →
Assistant next to the system prompt — both fields render the CURRENT
effective text filled in (the default as the value, never a placeholder),
with save/reset per field.

Verified live on devbox (0.3.23): picker renders the codex entries with
icons; in "Approve for me" a benign `date /t` auto-ran with no card (judge:
"read-only… harmless") while `del %TEMP%\…` was flagged (judge: "destructive,
irreversible… outside the workspace") and surfaced a card; approving it
completed the turn. Settings shows both prompts as filled text.

## Shell tools no longer flash a console window (0.3.22)

Every execute tool call on the Windows desktop popped a cmd window for the
command's lifetime: the host is a GUI-subsystem process, so each cmd.exe
child got a freshly allocated console. Fixed in guild-core's shell tool:
CREATE_NO_WINDOW (0x08000000) on spawn, and stdin pinned to null — the
latter also fixes interactive prompts (bare `date` waits on inherited
stdin, hanging until the 30s timeout). Verified live on devbox: a ~6s ping
approved and executed in the GUI while a window-title poll (12 samples)
and a full-desktop screenshot both show no console window; exit code 0 and
full stdout captured.

## Approval decision deadlock fixed (2026-09-14)

Ask-mode approvals hung forever: the turn's generate awaits the approval
awakeable, and per Restate a virtual-object handler awaiting an awakeable
keeps the instance locked — so this morning's `claim_approval` (cb9f84e), an
EXCLUSIVE wake handler invoked on the same object, inboxed behind the
waiting turn forever and the decision could never land. Observed live: the
auto-deny timer's claim ran and found the key absent (the stuck
invocation's state never applied — restatedev/restate#5196 class), and a
fresh turn's claim vanished silently behind the lock. Upstream issue #5196
describes the wider "suspended with open Run completion" jam; worker
restarts and re-registration do not recover it; only killing the invocation
(or wiping restate's container layer — it mounts no volume) frees the key.

Fix: the resolution moved back into the shared `complete_approval` handler
(mirroring `complete_tool`), and the exclusive `claim_approval` handler was
deleted; first-answer-wins is enforced by Restate dropping late completions
for an already-resolved awakeable, and the waiting turn clears the state key
on resume. Verified end-to-end in the GUI on devbox: Ask mode → Approve →
decision journaled → tool dispatched and executed on the WORKSTATION machine →
answer rendered; no duplicate thinking block (the catch-up thinking buffer
now replaces the turn's existing reasoning block instead of appending one
below the approval card); execute approvals render a terminal-style
`$ command` line instead of the raw JSON args. Desktop 0.3.21 published and
installed on devbox.

Operational notes from the same incident: deploys kill in-flight turns (the
worker does not drain); the restate container has no volume so its state
lives in the container layer (`restart` keeps a jam, `rm` clears it); the
stuck-generation sweep only kills version-mismatched invocations — this jam
had a matching restate.rs hash, so the sweep skipped it.

## Composer approval-mode selector (2026-09-14)

The codex-style "how should tools be approved" control now lives in the
composer itself (pill next to the folder chip): per-chat mode with four
entries — Account default / Ask for approval / Auto-approve / Deny tools.
Backend: migration 0043 (`chats.approval` jsonb), owner-scoped
GET/POST `/api/v1/chats/{id}/approval` (`{"default": "ask"|"allow"|"never"|"default"}`),
and the approval gate reads `c.approval` first, falling back to the
account-level policy (`u.approval`, Settings → Approvals keeps the
user default + per-tool overrides — those apply only while the chat is on
the account default). Verified behaviorally on devbox with the WORKSTATION
machine: `allow` runs write_file with no card, `never` returns
"denied by policy" without dispatching, ask keeps the card flow. Desktop
0.3.20 built, published, installed on devbox; server deployed.

## Machine presence + link robustness (2026-09-14)

Root causes of the recurring "No machines connected" while a desktop app
was installed (devbox/Windows): the link stream dies every few minutes
behind Cloudflare (`error decoding response body`, reconnect gap ~19s), and
three bugs turned each flap into an outage: (1) the server's
`ExecutorGuard::drop` unregistered the machine the moment the stream
dropped; (2) the desktop spawned its heartbeat loop inside the stream
connection and aborted it with the stream — the documented design says
heartbeats run independently; (3) Cloudflare keeps the origin leg of a dead
client connection open, so per-user stream permits leaked until the cap
(3/user) 429'd every reconnect — observed live (`stream connect: HTTP 429`
in the app's rpc.log). After a server redeploy the zombie is worse: silent
(no bytes, no error), so the app never reconnects and stops receiving tool
frames while heartbeats keep it "present".

Fixes (all verified live on devbox): server — `ExecutorGuard::drop` is a
no-op (TTL is the offline signal, `EXECUTOR_TTL_SECS` 15→30) and a new
connect for the same `machine_id` evicts the previous link stream via a
versioned `watch` (`AppState::machine_link_signals`), reclaiming leaked
permits; desktop — the heartbeat loop moved out of `link_once` into
`app_link_task` (survives flaps) and the link read loop has a 90s stall
watchdog (keepalives every ~30s; silence → reconnect). Desktop version
0.3.19 built (NSIS via cargo-xwin), published to /api/v1/updates, installed
on devbox; local tool calling driven through the GUI via WebView2 CDP
(SSH-tunneled 9222): read_file executed on the Windows machine and the
content returned in-thread. Note for GUI automation: the webview re-pushes
the workspace dir from `localStorage["guild.dir:<chatId>"]` on every send —
setting it via direct `set_chat_dir` invoke alone gets overwritten with
None.

## Tool kind + namespace cleanup (2026-09-14)

- Every `ToolSpec` carries a top-level `kind: ToolKind` — `web_search`,
  `web_browse`, or `generic` (serde/default `generic`). Set semantically on
  the in-code web integrations: searxng `web_search` → `web_search`,
  superproxy `web_fetch` → `web_browse`, firecrawl `search` → `web_search`,
  `scrape` → `web_browse`, `map` → `generic`. Everything else defaults to
  `generic`. The provider request builders pick only
  name/description/parameters, so kind never leaks to the model wire.
- The thread UI labels frames by kind first ("Web search" / "Browse"), so
  firecrawl calls render natively instead of "firecrawl search". Kind rides
  on `ThreadEvent::ToolResult` (serde default; old events lack it) and on
  `StreamEvent::ToolStarted` for live frames; pre-kind events fall back to
  the widget meta kind, then to the bare tool name.
- The `int_` tool-name prefix is gone globally: wire names are now
  `<slug>_<tool>` (e.g. `searxng_web_search`, `firecrawl_scrape`), auto
  tools are `<slug>_list_tools` / `<slug>_guide`. `unnamespaced_tool` still
  strips the legacy `int_<slug>_` shape and `parse_auto_tool` tolerates the
  legacy prefix, so journals recorded before the rename replay and old
  thread events keep rendering. Registry manifest tool-name length cap
  adjusted (64 − slug − 1).
- The system-prompt web-search instruction is kind-based now (fires when a
  permitted tool has kind `web_search`, wording "web-search tools (kind
  web_search)") instead of matching the literal tool name.
- TS bindings regenerated (new `ToolKind.ts`; `ToolSpec`/`ThreadEvent`/
  `StreamEvent` updated). Suite 308 passed across server/protocol/core/
  app-server; desktop vitest 14 passed; deployed to :18080 (new bundle
  hash, health ok).

## Providers are named, editable objects (2026-09-14)

- A provider is now `{slug, name, protocol, base_url, key}`: the display
  name is free-form ("openai" names a wire protocol, not a provider), the
  protocol (`openai` | `anthropic`) selects the provider implementation,
  and model routes keep referencing the stable slug. Migration 0040
  backfills name/protocol from the legacy slug (which was doubling as both).
- Admin API: `GET/POST /api/v1/admin/gateway/providers`,
  `PUT/DELETE /api/v1/admin/gateway/providers/{slug}` — slug derived from
  the name (lowercase, dash-joined), 409 on duplicates, blank key on update
  keeps the stored key, unknown protocol 400. The old `/keys` endpoints are
  gone. Route resolution falls back to slug-as-protocol when the provider
  row is gone (pre-0040 shape); a deleted provider's routes fail
  `key_missing` (the LEFT-JOIN NULL decode used to surface as a 500).
- The wire-protocol match moved into `guild_core::provider::for_protocol`;
  all six call sites use it. `RouteRow`/`RouteMeta` carry `protocol`
  (serde default for old journals); usage still records the slug.
- UI (Models section): providers are a data table with their own
  URL-addressed sub-pages — `/settings/models/provider/new` and
  `/settings/models/provider/<slug>` (detail = fact cards + Edit + two-step
  delete; routes show the provider's name, add/edit pick from a provider
  select). Live: renamed the seeded provider to "Local gateway".
- `useCachedGet` gained a `settled` flag (fetch completed on this mount):
  provider detail uses it to render "not found" only after a fresh fetch,
  not on a stale pre-create cache (the create→navigate flow flashed
  not-found without it).
- SPA fallback fix (`http/web.rs`): dotted non-API paths (model ids,
  provider slugs like `v1.5`) used to 404 because the fallback skipped
  anything containing a dot; now a real bundled file wins and everything
  else serves index.html. Live-verified:\  `/settings/models/GLM-5.3-Flash`
  deep-links again.
- Verified live on :18080 via agent-browser: providers list/detail/edit
  (renamed openai → Local gateway), create (slug `scratch-test-co`,
  anthropic protocol) → deep link → delete, deleted-slug not-found page,
  route detail/edit provider select, and an end-to-end chat turn through
  the renamed provider (streamed + usage recorded). Suite 212/214 (the 2
  stragglers are the known load-flaky SSE fan-out tests; pass in isolation).
  Note: test runs need `GUILD_TEST_PG_URL` exported (removed in the S8
  security round); host-postgres admin creds are in `/srv/postgres`.

## Review loop rounds 4–8 (2026-09-14) — exited CLEAN

- Two-lane review loop (security + features/correctness) ran to its exit
  condition: round-8 reviews returned CLEAN on both lanes. Reports in
  `docs/reviews/2026-09-14-*-round4..8.md`; every fix round was verified by
  a separate verifier pass before reviewers re-entered.
- Fixed along the way: registry approval now binds to the exact manifest AND
  bundle sha256 (`reviewed_version`/`reviewed_bundle_sha256`, migrations
  0037/0038, content-addressed bundle objects, approve requires
  version+hash and 409s on stale) — republished/byte-swapped bundles cannot
  govern access without re-review. Legacy (hashless) rows fail closed until
  an admin re-approves after a republish. `guide_object_key` resolves only
  approved skills and degrades to "no guide" on store errors. Events SSE is
  capped (64 global / 3 per user). The stuck-generation sweep parses
  `version:invocation` and kills only on confirmed stale. Turn-failure path
  no longer duplicates a persisted assistant turn (`step_persisted` set at
  stream start, buffers cleared after persist). Desktop: busy stays set
  until the fan-out done/error frame; attachment chips swap to uploaded ids
  before composer URLs are revoked; engine-approval timeouts release their
  pending entries; IntegrationDetail resets across navigation.
- Deployed to :18080 after each fix round (health ok). NOTE for admins:
  registry integrations/skills approved before migration 0038 stop
  resolving/downloading/installing for members until re-approved (fail-
  closed transition, by design).

## Admin UI rework: data tables + polish kit (2026-09-13, branch `admin-ui-rework`)

- Full settings rework, design decision in `docs/admin-ui-options.md`, plan
  in `docs/plans/2026-09-13-admin-ui-rework.md`. Foundation: generic
  **DataTable** (`packages/ui/src/components/data-table.tsx`, TanStack
  Table v8 — search, sortable columns, pagination, row click, loading
  skeleton, empty state), **AlertDialog** confirm dialogs and a themed
  **sonner Toaster** (`packages/ui`, mounted once in App). Settings-local
  primitives in `apps/desktop/src/views/settings/components/`:
  PageHeader (title + description + actions + breadcrumb back), Field,
  EmptyState, FactCard/FactGrid.
- Reworked sections: Users (table w/ 30d spend sparkline + fact-card detail
  + AlertDialog delete), Teams (table + members card), Models (keys cards +
  routes table + dialog-driven add key + fact-card detail), Integrations
  (one unified table — configured rows + not-configured catalog entries with
  status column; detail keeps JSON config, secrets, tool policy, all deletes
  confirmed via dialogs), Registry (unified table w/ kind + review columns,
  fact-card detail), SSO (fact cards + remove dialog), Usage (header restyle,
  text-sm tables), Approvals/Assistant (Field + toasts), Account/Appearance
  (PageHeader + FactGrid). Sidebar active rows get a leading indicator bar;
  content column widened to max-w-4xl; every section renders its own
  PageHeader (the SectionPane title was removed).
- All destructive actions (delete user/team/route/key/integration/secret/SSO)
  are AlertDialogs with semantic red confirm buttons; all save/delete/add
  actions toast success/failure. Endpoint shapes and URL routing unchanged.
- Verified: tsc + vite clean; deployed to :18080 (compose build+up);
  browser-clicked users list/detail, teams, models, integrations, SSO and
  the delete-team confirm dialog (cancelled, nothing deleted).

## Seamless navigation: stale-while-revalidate everywhere (2026-09-13)

- Settings sections no longer flash a skeleton on every navigation. A
  module-level GET cache (`apps/desktop/src/views/settings/use-cached-api.ts`)
  keeps the last successful response per path; `useCachedGet` renders the
  cached value immediately on mount and refreshes in the background, so
  back/forward and section switches update content in place. Skeletons
  appear only on the first-ever load of a path; a failed refresh keeps the
  cached content on screen. Query paths with dates (usage series, spend)
  quantize timestamps to 10-minute buckets (`quantizeIso`) so cache keys
  repeat across navigations.
- Rewired onto it: Integrations (list + secrets), Users (list + 30-day
  spend), Teams (list + members + org users), Models (routes + keys +
  detail), Registry (3 kinds + item detail), SSO, Usage (summary +
  breakdown + timeline), Machine (module-level last list). WebChat keeps a
  per-chat rendered-block cache (bounded, 20 threads): reopening a thread
  shows its last rendered content while the fresh thread rows load in
  place, so chat switches don't skeleton-flash either.
- Desktop 0.3.17 released (all 4 platforms, installer format, updater
  signatures verified) and compose server rebuilt on :18080 — both
  include this, the integration id-addressing below, and the earlier
  integration-category fix (rows carry `category`, so configured built-ins
  like gitlab no longer show under "MCP plugins"). devbox's desktop app
  upgraded in place (silent NSIS + relaunch).

## Integrations are id-addressed db objects (2026-09-13)

- Every configured integration — built-in connector or registry MCP plugin
  — is a db row with a stable id. Migration 0030: `integrations.id UUID`
  becomes the primary key; `(org_id, name)` stays UNIQUE, so the resolver,
  secrets store (still keyed by connector slug) and tool namespacing
  (`int_<slug>_<tool>`) are unchanged.
- Admin API: rows carry `id`; `POST /api/v1/admin/integrations {name}`
  creates a configuration row (409 `already_configured` if one exists,
  404 for unknown connectors) and returns the row; `PUT` / `DELETE` and
  the secrets endpoints moved to `/api/v1/admin/integrations/{id}[/secrets]`
  — the by-name routes are gone. Secrets can only be staged on an existing
  row now (the UI creates the disabled row first).
- UI: the integrations list opens detail pages by id
  (`/settings/integrations/<id>`, deep-linkable); clicking a not-yet-
  configured connector creates its disabled row and lands on its id; a
  deep link to a deleted id renders a not-found note.
- Tests updated to the id flow (builtin_plugin, admin_integration_policy
  incl. a new create/conflict/unknown/delete round-trip test); all 27
  integration tests green, desktop tsc + vite clean. Deploy + desktop
  release happen with the concurrent 0.3.17 build (peer session).

## Single-process desktop (2026-09-13)

Spec `docs/specs/2026-09-13-single-process-desktop.md`, plan
`docs/plans/2026-09-13-single-process-desktop.md`. Trigger: the webview held
presence (its SSE died 2ms after boot and never retried) while execution sat
in the daemon → chats worked but every machine tool failed "bound machine
offline".

- **One process**: the GUI hosts the engine (session, JSON-RPC dispatch,
  local tool execution). No headless daemon, no cross-process pipe, no
  supervisor/build handshake. Window close → tray; real exit from the tray
  menu; single-instance plugin. The CLI socket is still hosted — by the GUI
  process (own restored session); `daemon::attach` no longer spawns anything
  and fails cleanly when the app is closed.
- **One standing connection**, owned by the app process (not the webview):
  events/stream with machine params = registration (executor_acquire) +
  **user fan-out bus** — every frame of the user's chats (deltas, thinking,
  tools, approvals, done/error), wrapped {chat_id, machine_id, event}, to
  every connected device; in-flight state replayed on connect/reconnect
  (buffer snapshots + suspended tools). Heartbeats (5s) UPSERT the machine,
  so a stream flap never unregisters a running app.
- **In-person execution**: the app process executes client tools when the
  bus delivers ToolStarted for a chat bound to its machine (chat→dir map
  pushed by the webview's run-in-folder state via set_chat_dir), then POSTs
  the result. No folder mapped → error result telling the user to use "Run
  in folder…". Webviews render only; web clients unchanged.
- Webview turn flow (desktop): send = fire-and-forget POST (sendChatNoStream,
  SSE body dropped); frames arrive as `app-frame` Tauri events routed by
  chat_id with per-chat seq watermarks; catch-up = `chat_snapshot` (the
  app process's in-flight mirror). app-stream-reconnected → thread reload +
  re-snapshot.
- Verified locally (xvfb smoke): boot without panic, link registers
  (heartbeat upsert), full tool loop end-to-end via API (dispatch → execute
  → result POST → model continues; folder-less error message rendered),
  CLI `chat` verb against the hosted socket, CLI fails cleanly with no app.
- Desktop 0.3.16 pending release; devbox deploy pending.

## Distinct URLs for all pages; settings sub-pages (2026-09-13)

- Every distinct page now has its own URL. Settings sections already had
  `/settings/<section>`; the sub-pages inside them were component state
  (refresh/back lost them, no deep links). They are now URL-driven:
  `/settings/integrations/<slug>`, `/settings/users/<id|new>`,
  `/settings/teams/<id|new>`, `/settings/models/<model|add>`,
  `/settings/registry/<kind>/<slug>`. Each detail segment is
  encodeURIComponent-ed per path segment, so model ids containing `/`
  round-trip.
- Plumbing: settings overlay route gained a `detail` part (parseChatRoute /
  chatRoutePath / pushRoute in WebChat); SettingsWindow forwards
  `detail` + `onDetailChange` through SectionPane/SectionBody/LazySection;
  sections with sub-pages (Integrations, Users, Teams, Models, Registry)
  take their open page from props (shared `SectionDetailProps` in
  `settings/section-nav.ts`) instead of local state.
- Create flows land on the created object's own URL
  (POST /admin/users and /admin/teams return the id →
  `onCreated(id)` → `/settings/users/<id>`).
- Deep-link loading guard: detail pages wait for the list fetch before
  resolving the id, so a fresh reload never renders a configured item as
  the "not configured" draft form (hit on slack on first verification).
- Verified live on :18080 via agent-browser: deep links render the right
  page after full reload (integration, user, model add, registry item),
  click-through pushes the URL, browser back returns to the section list.
- Deployed to the compose stack (:18080).

## Run in folder, context-aware UI (2026-09-13)

- The desktop chat regains "run in folder" (lost when AgentView was retired
  from the surface): a composer chip — "Run in folder…" picks the workspace
  before sending, chip shows the folder with an ✕. Web (browser) clients
  render none of it; the chip is desktop-only (`isTauri`).
- Per chat: folder remembered in localStorage (`guild.dir:<chatId>`, plus
  `guild.dir:last` as the default for new chats), restored on thread switch;
  sent per turn as `project_dir` on the gateway request (server plumbing
  pre-existed — build_system_prompt names the workspace); the local tool
  executor runs in that folder (mid-turn blind folder picker kept only as a
  fallback when no folder is set).
- Deployed to the compose stack (:18080) — browser UI live. Desktop 0.3.15
  published (all four platforms, sha256-verified; updater manifest is
  Host-relative, so artifact URLs follow the endpoint the client fetches
  from). Released via `scripts/release-clients.sh` with an admin session
  minted directly in the guild postgres (revoked after the run; the old
  debug token is dead). systemd-run jobs need the full PATH
  (`~/.cargo/bin` for cargo-xwin, nvm node for npm) or the windows build
  fails with `cargo-xwin command not found`.
- Deployed to devbox (the Windows host): new exe copied over
  `AppData/Local/Guild/guild-desktop.exe` (old one kept as
  `.0314.bak`), running daemon killed first, GUI relaunched. NOTE: the
  installed layout is the raw exe (not the NSIS app dir) — devbox updates
  are manual exe copies; the auto-updater would have delivered the NSIS
  installer instead.
touching the codebase; detailed milestone plans live in `docs/plans/`,
deploy nuances in `docs/deploy-nuances.md`, hang-patterns in
`~/workspace/hanging-commands.md`.

## Milestone 10 — unified plugins + real connectors (2026-09-12)

- Built-in and MCP integrations sit behind one interface: every
  `Integration` carries an in-code manifest (`in_code_manifest`, validated
  by the registry's own `validate_v2`), `execute` receives resolved
  secrets and the call's `acting_as` identity, and one resolver
  (`resolve_plugins` → `PluginTurn`) covers both kinds — same classes,
  policy filter, auto-tools, script API, and audit. An installed registry
  v2 bundle of a slug shadows a same-named built-in
  (`upsert_integration`, available list, secret-delete, resolver all
  follow that rule).
- Seven compiled-in connectors ship, all seeded with the credentials from
  internal project and live-smoked through the script API on :18080: slack
  (conversations, users, post_message), github (search, issues, PRs,
  files, create_issue), gitlab (self-hosted via `base_url` config,
  projects, issues, MRs, create_issue), atlassian (Jira + Confluence,
  basic auth), google_workspace (service-account JWT → DWD `sub` =
  acting identity; Gmail/Calendar/Drive/Directory), hubspot (CRM search;
  the internal project key is read-scoped so `update_deal` cannot fire live),
  langfuse (traces, `get_prompt` — the API requires a name, so there is
  no list-all tool).
- Slack's incoming-webhook tool was dropped: no webhook URL exists in
  internal project; `post_message` covers posting.
- Live smoke results: every read tool returned real vendor data; the
  slack write path fired for real (test message in #general);
  `create_issue`/`create_page` writes are wiremock-verified only (firing
  them would leave persistent artifacts in shared repos). hubspot
  `update_deal` is wiremock-verified only (read-scoped key).
- Secrets loaded via the admin API from `~/acme/internal project/.credentials`
  (loader script: `~/workspace/projects/m10-load-secrets.sh`, values
  never echoed). gitlab's `base_url` is the full API root
  (`https://gitlab.acme.dev/api/v4`); langfuse host is a secret.
- Plan: `docs/plans/2026-09-12-milestone-10-unified-plugins.md`; branch
  `integrations-v2-connectors`.


## UI pass — 16px text, floating scrollbars, settings sidebar (2026-09-12)

- Body text moved to the 16px base: all `text-sm` usages in the desktop
  app are now `text-base` (tiny `text-xs`/`[10px]` labels and pills
  unchanged).
- Floating scrollbars: native bars hidden (zero width, no reserved
  gutter); `scroll-activity.ts` renders a floating thumb over each
  scrolling container's right edge, visible only while it scrolls
  (~0.7s after the last event). Horizontal scrollers have no indicator.
- Settings sidebar resizable, sharing the chat sidebar width
  (`lib/sidebar-width.ts`, one localStorage key + same-tab resync
  event). Window-corner dialog X hidden for the fullscreen settings
  dialog (DialogContent gained `hideClose`); sidebar close button kept;
  Esc still closes.
- Per-chat cost chip removed from the thread header
  (ChatSpendChip.tsx deleted; /chats/{id}/usage endpoint untouched).

## Milestone 9 — integration plugin system (2026-09-12)

- Org integrations are now installable plugins: a registry bundle (kind
  `integration`) whose manifest v2 declares an MCP server url (streamable
  HTTP), auth shape (`org_secret` | `org_secret_impersonated` |
  `per_user_token`), per-tool classes (read/write/admin), triggers
  (routines), and guide skills. Spec:
  `docs/specs/2026-09-12-integration-plugins-design.md`; plan:
  `docs/plans/2026-09-12-milestone-9-integration-plugins.md`.
- The worker connects to enabled MCP plugins at turn start (journaled
  tool-list snapshot; connections pooled in AppState keyed by
  slug/url/acting-as/secrets-fingerprint), exposes namespaced tools
  `int_<slug>_<tool>` plus Guild-provided `int_<slug>_list_tools` and
  `int_<slug>_guide` disclosure tools, and enforces tool classes before
  execution. Compiled-in Rust plugins (searxng, superproxy) unchanged.
- Identity envelope on every MCP call (spec §5): org / caller /
  acting-as / call-id headers + secret headers; acting-as override is
  admin-only. Secrets encrypted at rest (0029_integration_secrets).
- Script surface: `GET /api/v1/integrations`,
  `GET /api/v1/integrations/{slug}/tools`,
  `POST /api/v1/integrations/{slug}/tools/{tool}` — session or org-API-key
  auth, policy-filtered, audited (`integration.tool_called`).
- Deployed to the compose stack (:18080); health + new routes smoke-verified.

## Desktop 0.3.10 — first release carrying the service-worker retirement (2026-09-12)

- 0.3.9 was cut ~12 h before the PWA service worker was retired
  (a2c0d64), so it still registered `sw.js`. On at least one Windows
  client the registered worker intercepts the `tauri.localhost` document
  request and the load hangs forever (DevTools: 1 request, Pending, 0 B;
  black window). 0.3.10 ships the retirement; its cleanup script only
  runs once a page loads, so a client whose worker already hangs the
  document needs manual WebView2 profile cleanup — the update cannot
  reach it through the updater.
- Also carries: settings at top-level /settings/<section>, /admin console
  removed (settings is the single admin surface).

## Settings: users add-flow, teams, SSO (2026-09-12)

- Users section reworked to the integration-style flow: list screen +
  "Add user" entry; the detail screen creates a user (email/password/role)
  or edits an existing one (role change, password reset, delete). New
  endpoint: PUT /api/v1/admin/users/{id} (IdentityStore::update_user).
- Teams section added (ORGANIZATION → Teams): list with member counts, add
  team, detail manages members (add from org users / remove) and delete
  team. Store: TeamStore gained list_members/remove_member/delete_team;
  TeamRow now carries member_count.
- SSO section added (ORGANIZATION → Sign-in / SSO): issuer / client id /
  client secret form (blank secret = keep current), remove-config, and the
  redirect URI to register at the IdP. Endpoints: DELETE /admin/oidc,
  public GET /api/v1/auth/oidc/status (single-org resolution).
- OIDC login is now a browser flow: redirect_uri and the post-login app
  redirect derive from the request's Host/scheme (not GUILD_API_URL, which
  is the internal docker address); callback redirects to the app with the
  session token in the URL fragment; WebLogin offers "Continue with SSO"
  when status reports configured, and app boot adopts the fragment token.
- Deployed to the compose stack (:18080); health + status endpoints
  verified live; UI flows not yet clicked through in the browser.
- Uniform admin state machine applied to Users, Teams, Integrations and
  Models: detail screens show saved data as read-only facts with explicit
  Edit (draft form with Save/Cancel) and two-step destructive confirms;
  no more always-live mixed forms. Teams gained rename (PUT
  /api/v1/admin/teams/{id}); integrations' enable toggle moved into the
  edit form. Registry already conformed; Usage/Approvals left to the
  session editing them.

## Desktop 0.3.13 (2026-09-12, latest)

- Poll-based rpc bridge: rpc_submit returns the request id in <1ms; a single
  rpc_poll loop drains completed envelopes to the webview. No invoke stays
  open for the duration of a daemon call, so the Windows-only hang (WebView2
  silently losing long-lived WebResourceRequested responses on maintainer's
  machine - daemon and pipe verified healthy in situ) cannot strand the UI.
  120s sweep injects timeout envelopes; reader exit drains pollers too.
- ipc trace (%TEMP%/guild-rpc.log) ships in every build; pipe_probe example
  for in-situ client-flow bisection.

## Desktop 0.3.12 (2026-09-12, latest)

- Build-identity handshake: daemon.hello now carries the workspace build id
  (git commit, protocol build.rs) and the GUI refuses + respawns any daemon
  from a different build — a leftover background service of an older install
  can no longer serve a new client (the Windows "Pairing…" hang after
  upgrading). Pair screen shows the running version (Guild v0.3.12).

## Desktop 0.3.11 (2026-09-12, latest)

- Fixes the 0.3.10 desktop pairing breakage: protocol-version handshake
  (crate-version compare desynced on every bump), webview API base
  (same-origin fetches can't work on tauri://localhost — use the paired
  server URL), legal Tauri 2.11 event names (no dots), bounded rpc_request,
  release-desktop.sh builds with tauri/custom-protocol. All platforms
  republished and signed; latest.json serves 0.3.11.

## Approval policy is user-scoped, not per-chat (2026-09-11, latest)

- Per-thread approval settings made no sense — tool trust is a property of
  the user and their bound machine, identical across conversations.
- Migration 0026: `users.approval JSONB` added; `chats.approval` (0023)
  dropped. Same guild-core ApprovalPolicy shape; NULL = server default
  (ask, read-only allowed).
- API: GET/PUT `/api/v1/me/approval` (auth.rs) replaces
  `/api/v1/chats/{id}/approval`. ChatRunner resolves the policy via
  `chats JOIN users` on the chat owner.
- Settings: Approvals moved from the "Current chat" group to "User"; no
  longer requires an open chat. Browser-verified flows pending next deploy.

## Tool frame UI polish (2026-09-11, late)

- Tool frame header keeps the request preview (search → query, fetch → URL,
  …) visible whether the frame is collapsed or expanded; preview text is no
  longer monospace.
- A running tool call pulses (`animate-pulse`) on the header line until its
  result lands; running frames no longer auto-expand (the body is empty
  until the result arrives anyway).
- `web_fetch` renders as "Browse" in the UI (wire name unchanged).
- Search/fetch expanded bodies show a pulsing "running…" line while the call
  is in flight. Verified live in the browser (search + fetch, running and
  completed states).

## Phase 2 — approvals as protocol events (2026-09-12)

Design: docs/plans/2026-09-12-approvals-design.md. Shipped and deployed:

- Approval policy: user-scoped `users.approval JSONB` (0026, was per-chat
  `chats.approval`), guild-core ApprovalPolicy semantics; NULL = server
  default (ask, read allowed). GET/PUT /api/v1/me/approval, editable from
  any client.
- ChatRunner gate in client_tool_step: allow -> unchanged; never -> denied by
  policy; ask -> durable `approval_request`/`approval_decision` thread events +
  `approval_requested`/`approval_resolved` frames, awakeable `approval:{call_id}`,
  5-min send_after auto-deny, shared `complete_approval` handler
  (first answer wins), POST /api/v1/gateway/chat/{id}/approvals/{call_id}.
- Attach replay emits ApprovalRequested for unresolved approvals.
- WebChat: pending/resolved approval cards; Settings approval selector +
  overrides editor. Excluded from model-facing history derivation.
- Browser-verified all four paths (approve/deny/never/allow) with a scripted
  executor (SSE presence + heartbeats + tool result POST).

## Context attachments — multimodal (2026-09-11, latest)

- Composer "+" attach (ChatGPT/Claude pattern): preview strip above the
  input — image thumbnails with overlay ✕, file chips with type icon +
  name + size; user bubbles render the same previews (authed blob fetch);
  inlined wire text stripped from display.
- Uploads go to object storage via POST /api/v1/chats/{id}/attachments
  (64 MiB cap); the send carries attachment_ids; the server inlines textual
  documents into the turn (80k-char cap per file) and passes image parts
  (OpenAI image_url data URIs / Anthropic base64 blocks) and audio parts
  (OpenAI input_audio, wav/mp3) ONLY when the resolved route lists the
  modality. Unsupported media stay stored for later code-execution tooling
  (by design, never dropped from the log).
- Modality capability is admin-configurable per route: model_routes.modalities
  TEXT[] (migration 0025, values image/audio/video), edited in Settings →
  Models; GET /api/v1/admin/gateway/routes returns it.
- Derivation continuity: build_model_history replays prior image/audio parts
  from a journaled-loaded media map on every turn — images persist in
  context like Codex/Claude sessions. Compaction summaries are text-only.
- Verified live: passphrase extracted from inlined .txt, 8x8 PNG identified
  as red, composer upload → preview → send → second-turn recall all pass.

## Unified settings window (2026-09-12, latest)

- Admin UI folded into the main app: a large Settings window (user menu →
  Settings) with its own sidebar — USER (Account, Appearance, Machine),
  CURRENT CHAT (Approvals), ORGANIZATION (Usage, Users, Models, Integrations,
  Registry, Releases; admin-only). Works identically in the desktop app and
  the browser; role-gated via /api/v1/auth/me (transport apiMe now returns
  role).
- Sections live in apps/desktop/src/views/settings/sections/, lazily loaded,
  using the shared admin-api helper (same session token as the chat).
- New backend endpoint: GET /api/v1/admin/gateway/routes (full route rows,
  no secrets) so Models editing is prefilled.
- The old /admin console still exists untouched during the transition; the
  desktop handoff link remains but the window is the primary surface now.

## Loading + staleness fixes (2026-09-12, latest)

- Deep links render the thread skeleton on FIRST paint — the new-thread hero
  appears only when the user explicitly creates a new thread.
- ThreadSkeleton is now conversation-shaped (skeleton bubbles/frames), not a
  spinner; all loading widgets use skeletons.
- Cache headers fixed at the source: hashed /assets/* are
  `immutable, max-age=1y`; index.html and sw.js are `no-cache` (previously
  NO cache headers at all — browsers heuristic-cached the shell, which is
  what made tabs go stale after deploys).
- Deploy freshness: the app polls the served shell every 60 s and reloads the
  tab when the bundle hash changes (never while streaming/loading). The SW
  itself was already network-first — headers were the root cause.

## Auto-compaction (2026-09-12, latest)

- **Manual Compact button removed from the UI** (and the gauge's Compact?
  hint) — compaction is server-side only: POST /compact stays for ops.
- **Threshold trigger**: before each model call, if the last request's
  tokens_in > context_window - 16384 (pi's reserve), the ChatRunner compacts
  first (shared compact_core) and continues with fresh derivation.
- **Overflow trigger**: provider errors matching pi's overflow regex port
  (crates/server/src/worker/overflow.rs, with non-overflow exclusions like
  rate-limit) compact once and retry the call exactly once per turn.
- Auto-compaction tokens are metered through the same usage path.

## Compaction + context gauge + desktop 0.3.9 (2026-09-12, later)

- **Compaction** (docs/plans/2026-09-12-compaction-design.md): on-demand via
  the composer-row Compact action or POST /gateway/chat/{id}/compact. The
  model summarizes pre-compaction history into a durable `compaction` event
  (summary, tokens_before, keep_last=4, model, usage); derivation replaces
  everything before it with summary + verbatim tail. UI: collapsed
  "Thread compacted" card. Compaction-call tokens are informational (not
  metered) — flag if quota accounting should include them.
- **Context gauge**: model_routes.context_window (0024, admin-settable,
  fallback 128k); GET /thread returns {tokens, max, model}; slim fill bar
  next to the model selector (amber >80%, red >90%, "Compact?" hint >90%).
- **Desktop 0.3.9 published** for linux/darwin-x64/darwin-arm64/windows,
  sha256-verified; updater delivers once. Ships thread events UI, thinking,
  tool widgets, approvals, compaction, gauge.

## Thread event log milestone (2026-09-12, this session)

Full redesign per `docs/plans/2026-09-12-thread-events-design.md` (grounded in
`docs/deepseek-harness-study.md`):

- **Thread = append-only `thread_events` table** (type + JSONB payload, uuid v7
  ordering). Event types: user_message, system_message, assistant_message
  (blocks: reasoning/text/tool_call in stream order + usage + model),
  tool_result (content + is_error + widget meta), compaction (reserved). The
  old messages table is DROPPED (0022); model-facing history is a derivation
  (`build_model_history` in worker/restate.rs).
- **Reasoning never dropped**: ProviderChunk::Thinking parses
  `delta.reasoning_content`; assistant turns persist a reasoning block; every
  reasoning-carrying turn replays `reasoning_content` to the model (dsh rule).
  StreamEvent::ThinkingDelta streams to clients; first frame after attach
  carries the full buffer.
- **Tool presentation**: ToolResult events carry tool-private `meta` (dsh
  presentationMeta pattern): web search cards (sources), web fetch cards
  (url/status/truncated), terminal/read/diff tags on client tools via
  ToolOutcome.meta. WebChat renders collapsible tool frames + per-tool
  widgets; reasoning blocks are collapsible "Thinking" frames.
- **Integrations**: trait gains category() (search/fetch/other); NEW superproxy
  plugin (fetch provider) with web_fetch against the superproxy gateway
  /v1/fetch; searxng emits search meta; admin API + new admin webui
  Integrations view (grouped by category, config editor).
- **API**: GET/POST /api/v1/chats/{id}/thread replaces /messages. Engine
  sessions append tool results via POST /thread (turn-join).
- Suite: 117 tests green (nextest, host services). Desktop/webui tsc+vite clean.
- Browser-verified live (agent-browser): multi-turn chat, web_search + web_fetch
  via UI, tool widgets from persisted meta after reload, reasoning frames,
  empty-sheet rendering, admin Integrations view. Hotfixes landed post-deploy:
  user turn missing from model request (derived before append), chat
  generation lock leaked on pre-turn terminal failures, turn-failure error
  logging.
- Orchestration was run via herdr panes + dagr run file (.dagr/run.json,
  gitignored); workers: store/providers/integrations/webchat/adminui/loop +
  followup T9; orchestrator did protocol base, engine-path fix, merges,
  verification. Worker panes retired after merge.

## Shipped (2026-09-12, later)

- **Tool calls survive page refresh** (client fix, server redeployed): tool
calls were always persisted, but WebChat's history rebuild filtered to
user/assistant rows only. New `msgsToBlocks()` in
`apps/desktop/src/views/WebChat.tsx` rebuilds tool chips from assistant
`tool_calls` + `tool` result rows (joined by `tool_call_id`);
`ChatMessage` in transport.ts now declares the tool fields. No migration.

## Infra (2026-09-12)

- **Default operating mode: shared host services.** Prod and tests use the
  neutral host postgres (`/srv/postgres`, :5432), host ClickHouse
  (`/srv/clickhouse`, :8123, user `ch_user`), and rustfs (:9950). No
  testcontainers; compose infra is behind the `fullstack` profile and
  stopped. Details: `docs/deploy-nuances.md` §0.
- Prod data migrated 2026-09-12 and verified live (usage 71 rows from host
  CH, releases from rustfs, pg_dump of users/chats into host postgres).
  Pre-cutover volumes (`pgdata`, `chdata`, `miniodata`) still exist as
  rollback; stale orphan cluster parked at `/srv/postgres.old-20260912`.
- `GUILD_CLICKHOUSE_USER`/`GUILD_CLICKHOUSE_PASSWORD` config keys added
  (`Config::clickhouse_client()` centralizes auth); deploy compose server
  reaches host services via `extra_hosts: host.docker.internal:host-gateway`.

## Shipped and deployed (as of 2026-09-10)

- **Server** live at `:18080` (compose stack, image rebuilt + restarted).
  Desktop **0.3.7** published for linux/darwin-x86_64/darwin-aarch64/windows
  (sha256-verified on upload; updater delivers it once — no loop). 0.3.7 is
  the daemon milestone: per-user daemon (survives client closure, shared by
  all windows + CLI verbs, only session-token route to the server), GUI
  attaches over a local socket, `engine` mode removed, `daemon.hello`/
  `daemon.shutdown` handshake, workspace version bumped to 0.2.0 for the
  handshake. Plans: `docs/plans/2026-09-10-milestone-8-daemon.md`;
  watch-items: `docs/deploy-nuances.md` §Daemon watch-items.
- **Server-owned system prompt** (also in `d370726`): the ChatRunner workflow
  builds the prompt server-side (`build_system_prompt` in
  `worker/restate.rs`) — role, client-tool guidance, web_search-only-for-
  general-knowledge, workspace path from the optional `project_dir` field on
  `ChatCompletionRequest` (forwarded by the gateway; desktop `agent_session`
  sends it). The client's `system` field stays unused for agent turns; don't
  reintroduce client-side prompts.
- **Machine-bound executor model** (commit `d370726`):
  - Chats bind to one machine (`chats.machine_id/machine_label`, migration
    0019). Desktop auto-binds itself at chat creation; web binds via
    Settings → Machine. A run executes tools ONLY on the bound machine.
  - Executor registry in `AppState`: **heartbeat-based liveness**
    (`EXECUTOR_TTL_SECS = 15`; desktop pings `/api/v1/machines/heartbeat`
    every 5s). TCP-level disconnect detection is unreliable through
    docker-proxy — do not reintroduce it.
  - Machine tools declared to the model when `client_tools` OR the chat is
    bound → web-originated turns can use the bound machine.
  - Fail fast: unbound chat → "not bound to a machine…"; bound-but-offline →
    "machine 'X' is offline…". Both verified live; the model relays them.
  - Machine watcher: a suspended tool is aborted ("bound machine 'X' went
    offline before executing it") ~20s after heartbeats stop; 5-minute
    journaled `send_after` stays as backstop. All resolution flows through
    the durable `complete_tool` shared handler (replay-safe).
  - Pending tool replay on attach: late-attaching clients receive suspended
    `ToolStarted` events and can execute/answer them.
- **Unified desktop shell**: the desktop webview runs the same `WebChat` as
  the browser over HTTP (engine token → `localStorage.guild_token`);
  AgentView retired from the surface (file kept). Admin-console handoff link
  kept. `tauri.conf.json` version must be bumped on every desktop release
  (updater compares it).
- **Infra fixes in the same commit**:
  - events SSE listener uses a **standalone PgListener connection** — the
    pool-based one leaked a pool connection per stream and exhausted the
    pool (all authenticated endpoints then hang forever). See
    `~/workspace/hanging-commands.md` Patterns 5–8; always `curl --max-time`.
  - `watch::Sender::send()` fails with no receivers (counts froze at 0) —
    any future liveness channels must use `send_replace` or heartbeats.

## Verified live (curl + browser, 2026-09-10)

Unbound fail-fast ✓ · offline fail-fast ✓ (2s turns) · suspend while machine
alive ✓ · heartbeat liveness through stream drop ✓ · death-abort ~20s ✓ ·
retry-then-fail-fast ✓ · coherent model answers ✓ · machine chip in header ✓
· Settings Machine section ✓ · attach replay of pending tools ✓.

## In flight by other sessions

- **Milestone 8 (daemon)** — session `01a08b19`, plan in
  `docs/plans/2026-09-10-milestone-8-daemon.md`. Started after `d370726`
  landed. Touches `crates/app-server/src/jsonrpc_loop.rs` (note: it contains
  a small additive `machine.info` handler returning the hostname) and
  `apps/desktop/src-tauri/src/main.rs`.

## Known gaps / next up

## Resolved 2026-09-12: Windows pairing hang (desktop)

**Root cause** (diagnosed in situ on the user's Windows box via WSL SSH + a
daemon-side trace): the GUI's reader thread did a blocking read on a
duplicated *synchronous* named-pipe handle. Windows serializes I/O on the
file object, so the concurrent first rpc write queued behind the parked read
and never ran \u2014 every fresh launch froze deterministically at its first
daemon call. Unix sockets have independent fds, which is why no local test
ever reproduced it.

**Fix** (`48f9156`, released as desktop **0.3.14**):
- Windows client is now a **tokio named-pipe client** (mirrors the daemon's
  ServerOptions side): true concurrent read/write, async handshake carrying
  build identity + daemon pid.
- A **supervisor task** owns the daemon lifecycle: pings every 20s; on
  repeated silence sends `daemon.shutdown`, then taskkills the wedged daemon
  by pid and respawns \u2014 a wedged daemon can never hang the UI again.
- `daemon.hello` reports its `pid`; `Pair` carries the raw read handle;
  `release-clients.sh` defaults BASE to `https://guild.example.com` so
  updater URLs work without the user's SSH tunnel.

**Verified end-to-end on the user's machine**: 0.3.14 silently installed,
attach/handshake/ping/session.info/machine.info all < 1ms through the new
path, and the machine registered on the server (`machines` \u2192 `WORKSTATION`) with
the session restored in the webview. Paired against the public URL directly
(no tunnel).

1. **Phase 2 — approvals as protocol events** (agreed design, not built):
   workflow requests approval → broadcast to ALL attached clients → first
   Approve/Deny wins via `complete_tool`-style answer, recorded server-side;
   `ask/allow/never` becomes a server-side chat setting editable from any
   client; approval cards in the unified UI.
2. **Desktop engine as first-class executor** (agreed, not built): engine
   sessions (`cloud.rs` / AgentView path) send no machine binding, no
   heartbeat, no client_id — engine-originated agent sessions fall back to
   the 5-min timeout for client tools and don't register as executors.
3. **Thread-list status feature** — BUILT 2026-09-14 (design
   `docs/plans/2026-09-14-thread-list-status-design.md`, migrations
   0041/0042): `chats.generating` is flipped by the ChatRunner in journaled
   steps (entry after route/quota resolution, cleared at final answer /
   uniform failure / step limit; the stale-generation sweep also clears it
   for chats whose records are dead). Unread is derived at list time
   (assistant turn newer than the (chat,user) `chat_reads` marker on a
   non-generating chat; 0042 backfills markers so pre-existing threads
   start read). Status propagates on a notify-only channel
   (`guild_chat_status`) through the events stream as `chat_status` SSE
   frames, owner-scoped; web clients consume their stream now, the desktop
   app process routes SSE by event name and forwards chat_status as a
   `chat-status` Tauri event outside the seq watermark. Sidebar rows show
   a spinner while generating, a dot when unread; mark-read fires on
   thread load and turn end for the visible open chat (hidden tabs keep
   their dot). Verified live: background turn → spinner → dot → click →
   read (UI + server agree). Watch-item: event-stream slots are
   per-user-capped (3) and stale connections through docker-proxy linger —
   repeated client reloads can 429 a tab's stream until the server
   restarts or stale connections time out.
4. **Full desktop sign-out**: currently drops only the webview token; the
   engine session persists (needs an engine logout rpc).
5. **Embedded Restate runtime for tests**: gateway chat routes through the
   Restate ChatRunner, but test_support points `restate_url` at a placeholder.
   10 integration tests are `#[ignore]`d with that reason (agent_rpc x2,
   engine_stdio, roundtrip x2, gateway_api x2, gateway_tools, quota_api,
   usage_api, web_serving) — un-ignore all of them together once tests embed
   a Restate runtime. Also: stray container health/S3 probes can land on test
   mocks via the docker-proxy listener collision; `received_requests()`
   assertions should filter on the specific path, not total count.
6. **Web (browser) clients cannot execute machine tools by design** — keep
   it that way; execution is executor-bound.
7. **Releases: move out of the API data model** (maintainer, 2026-09-11):
   releases are dev objects existing outside the app workflow — publishing
   belongs to `scripts/release-clients.sh` and object storage, not to the
   product API surface. Today artifacts still live as
   `/api/v1/releases` + `/api/v1/admin/releases` rows; future task is to
   strip them from the API (keep only public download + updater manifest
   serving, backed directly by object storage).

## Conventions to keep

- Deploy = `cd ~/guild/deploy/compose && docker compose build server &&
  docker compose up -d server` (frontends are embedded via `include_dir!`).
- Long builds/tests: `big-job` skill (systemd transient units), never
  foreground. `curl --max-time` always. `PLAN.md`/docs updated on state
  changes so sessions can compact and recover.
- Orchestration topology (maintainer, 2026-09-12): split worker agents from the
  orchestrator's own pane (`herdr pane split --current --direction right|down
  --no-focus` + `herdr pane run <id> "cd <worktree> && exec pi"`), one git
  worktree per worker; retire each pane (`herdr pane close`) once its branch
  is merged. Waits: `herdr agent get` first — `agent wait --until` only fires
  on future transitions and hangs on settled agents; never sleep-poll.
- Fast tests (2026-09-12, host-services mode): plain `cargo test` (default-members excludes
  `guild-desktop`; use `-p guild-desktop` explicitly for it — `--workspace`
  still builds it). `.cargo/config.toml` uses lld + line-tables-only
  debuginfo (changing rustflags invalidates the target cache once). Tests use
  the **host services** (no testcontainers): Postgres at 127.0.0.1:5432,
  ClickHouse at :8123, rustfs at :9950 — per-run isolated db/bucket on each.
  `Store::connect_test()` creates `test_*` databases on the host postgres
  (stale ones with no live connections are reaped on first use);
  `full_state()` gets a per-test ClickHouse db + S3 bucket on the shared
  host servers. Overrides: `GUILD_TEST_PG_URL`, `GUILD_TEST_CLICKHOUSE_URL`
  (+ `_USER`/`_PASSWORD`), `GUILD_TEST_S3_URL` (+ `_ACCESS_KEY_ID`
  /`_SECRET_ACCESS_KEY`). Suite: 38 tests ~3.5s with
  `cargo nextest run -p guild-server --features test-support`. Plain
  `cargo test` stays green and is the fallback. If a test run can't reach
  the host services, start them first (`/srv/postgres` compose up,
  `systemctl start rustfs`, `/srv/clickhouse` compose up).
- Debug session token `pi-debug-session-token-2` is extended 7 days
  (expires ~2026-09-17); revoke when no longer needed.
- Releases (maintainer, 2026-09-11) are dev objects, not API objects: they exist
  outside the app workflow and should not grow into product surface. Publish
  via `scripts/release-clients.sh` only; do not build product features around
  the `/api/v1/releases` data model beyond serving downloads + the updater
  manifest.
