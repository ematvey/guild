# Guild — current state of work

Updated 2026-09-10 after commit `d370726`. Read this before touching the
codebase; detailed milestone plans live in `docs/plans/`, deploy nuances in
`docs/deploy-nuances.md`, hang-patterns in `~/workspace/hanging-commands.md`.

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

1. **Phase 2 — approvals as protocol events** (agreed design, not built):
   workflow requests approval → broadcast to ALL attached clients → first
   Approve/Deny wins via `complete_tool`-style answer, recorded server-side;
   `ask/allow/never` becomes a server-side chat setting editable from any
   client; approval cards in the unified UI.
2. **Desktop engine as first-class executor** (agreed, not built): engine
   sessions (`cloud.rs` / AgentView path) send no machine binding, no
   heartbeat, no client_id — engine-originated agent sessions fall back to
   the 5-min timeout for client tools and don't register as executors.
3. **Thread-list status feature** (design agreed earlier, not built):
   per-chat `generating / done+unread / done+read` — `chats.generating`
   column + read-marker table, ChatRunner flips status via internal API,
   sidebar spinner/dot, future mark-as-unread.
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

## Conventions to keep

- Deploy = `cd ~/guild/deploy/compose && docker compose build server &&
  docker compose up -d server` (frontends are embedded via `include_dir!`).
- Long builds/tests: `big-job` skill (systemd transient units), never
  foreground. `curl --max-time` always. `PLAN.md`/docs updated on state
  changes so sessions can compact and recover.
- Fast tests (2026-09-10): plain `cargo test` (default-members excludes
  `guild-desktop`; use `-p guild-desktop` explicitly for it — `--workspace`
  still builds it). `.cargo/config.toml` uses lld + line-tables-only
  debuginfo (changing rustflags invalidates the target cache once). One
  Postgres testcontainer per test process, isolated DB per `connect_test()`
  call (`TestDb.url` is the app's database_url). ClickHouse + MinIO also
  shared per process (per-test DB/bucket). Preferred runner:
  `cargo nextest run` (installed 2026-09-10) — guild-server suite 38 tests
  in ~9s wall vs ~60s serial under plain cargo test. Plain `cargo test`
  stays green and is the fallback.
- Debug session token `pi-debug-session-token-2` is extended 7 days
  (expires ~2026-09-17); revoke when no longer needed.
