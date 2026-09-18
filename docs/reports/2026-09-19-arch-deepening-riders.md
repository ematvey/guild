# Report — jsonrpc_loop rider cleanups (PLAN-suggestions §5)

**Verdict: CLEAN** — all four riders landed; every verification suite green.
One intended micro-behavior change (login/pair now publish the machine-link
config, matching the documented contract — details in Deviations).

## What changed per step

### 5a — delete `run_agent` (mechanical)

- `crates/guild-core/src/agent/mod.rs`: deleted `run_agent` and every
  loop-only type (`AgentConfig`, `AgentHooks`, `AgentError`, `AgentResult`,
  `ModelTurn`, `ProviderTurn`). Zero production callers confirmed by grep
  before deletion. Kept `agent::policy` (`ApprovalPolicy` — used by
  agent_start.rs, worker/exec paths, `http/auth.rs`) and `ApprovalDecision`
  (used by the shim's approval oneshots and `agent.approve`). Module doc now
  states the durable gateway workflow is the only agent loop.
- `crates/guild-core/tests/agent_loop.rs`: deleted (all 5 tests were
  loop-level: tool-then-finish, never-policy-no-ask, deny-as-tool-result,
  max-steps, tool-failure-as-result). The one policy-level assertion they
  carried (override `Never` wins over tool default) was already covered by
  `policy.rs`'s `precedence` test — nothing worth re-homing.

### 5b — chat.send rides the shim's drive path (option i, TDD)

- `crates/app-server/src/agent_start.rs`: new `drive_chat` — consumes the
  same workflow frame stream `drive` does, maps `Delta` → accumulated
  `chat.delta` (full text, exactly the old surface), `Done` → `chat.done`
  + the `(message_id, cost_usd, tokens_in, tokens_out)` tuple for the RPC
  reply, `Error` frame → error; ends without `Done` → error. Two new tests.
- `crates/app-server/src/jsonrpc_loop.rs`: `chat_send_task` no longer calls
  `cloud.chat_stream` + `collect_turn` (the second completion loop is gone).
  It submits the identical `ChatCompletionRequest` the shim uses
  (`client_tools: false`, no tools/system/project — plain completion) via
  `cloud.stream_completion` and hands the stream to `drive_chat`. Response
  shape and event surface unchanged for CLI callers. (`CloudClient::chat_stream`
  itself stays — it is exercised by the roundtrip/ws_cloud CloudClient-level
  tests and cloud.rs is out of scope.)

### 5c — auth_state module (TDD)

- New `crates/app-server/src/auth_state.rs`: owns token.json + machine
  identity + link publication. `AuthState` (private fields: cloud, email,
  machine_id, client_id) with accessors and **one** transition method:
  `transition(AuthChange, store, link)` — mutate ⇒ persist ⇒ publish in a
  single call. `AuthChange::Login | Identify | SignOut` map 1:1 onto the
  verbs. Preserve-exactly behaviors carried over: login/pair always persist;
  identify persists only alongside a live session (anonymous identify parks
  in memory); sign-out clears the store and drops the link; publish
  recomputes the link config (generating the client id on first need) and is
  the boot-time publish too; `restored()` keeps the me()-validate / dead-token
  / offline-keep / email-upgrade semantics (the upgrade row preserves the
  stored machine label, as before).
- `jsonrpc_loop.rs`: `login` / `pair` / `machine.identify` / `session.clear`
  are now thin (parse params → `AuthState::transition` via the `auth_change`
  helper with the default store path; injectable-store variants kept for
  tests). `Session`'s auth fields collapsed into `pub auth: AuthState` —
  the fields themselves are private behind the module. `Shared::publish_machine_link`
  and `restored_session` are thin delegates.
- New `crates/app-server/tests/auth_state.rs`: the state-transition table
  — login → identify → sign-out → re-login → pair (against a wiremock
  auth server), asserting per transition: exactly one persist (file content
  checked at each step, gone after sign-out) and exactly one publish (watch
  version advances at each step, config value checked). Plus
  `anonymous_identify_parks_the_link_and_skips_the_store` (no token.json is
  even created; login adopts the parked identity). The four in-file
  `machine_link_tests` were re-pointed at the new API; they still pass.

### 5d — tool.run

`rg "tool.run" apps/desktop/src` (and src-tauri, and the CLI): **no callers** —
the webview never invokes the verb (docs/specs/2026-09-13-single-process-desktop.md
already planned its removal). Deleted the `"tool.run"` dispatch arm and its
handler from `jsonrpc_loop.rs`. Noted in the funnel doc per the suggestion:
nothing kept, no note needed beyond this report.

## Files touched

- `crates/guild-core/src/agent/mod.rs` (rewritten, 237 → 20 lines)
- `crates/guild-core/tests/agent_loop.rs` (deleted)
- `crates/app-server/src/auth_state.rs` (new, ~230 lines)
- `crates/app-server/src/jsonrpc_loop.rs` (thin auth verbs, drive-path
  chat.send, tool.run arm deleted)
- `crates/app-server/src/agent_start.rs` (+`drive_chat` +2 tests)
- `crates/app-server/src/lib.rs` (+`pub mod auth_state`)
- `crates/app-server/tests/auth_state.rs` (new)
- `crates/app-server/tests/machine_link_reconnect.rs` (constructs the
  session via `AuthState::from_parts` instead of raw fields)

Untouched, per scope: crates/protocol, gateway.rs, worker/*, apps/desktop,
PLAN.md. Not deployed.

## Test counts (before → after)

| suite | before | after | delta |
|---|---|---|---|
| guild-core total | 81 (58 lib + 5 + 2 + 11 + 5 agent_loop) | 76 | −5 (loop tests died with `run_agent`) |
| guild-app-server lib | 31 | 33 | +2 (`drive_chat` tests) |
| guild-app-server integration | 20 (2 agent_rpc ignored, 4 daemon, 3 engine_stdio, 1 reconnect, 3 mcp_skills, 4 registry_client, 2 roundtrip, 1 ws_cloud) | 22 (+2 auth_state) | +2 |
| guild-server --features test-support | 109 lib + 49 integration binaries' tests | unchanged | 0 |

Verification run (all green):
`cargo test -p guild-core` · `cargo test -p guild-app-server` (incl.
`engine_stdio` pair/unknown-method with `GUILD_TEST_PG_URL`; the gateway-run
tests stay `#[ignore]` as before — they need an embedded Restate runtime)
· `cargo test -p guild-server --features test-support` (50 binaries ok, incl.
the engine_stdio/shim suites) · `cargo build`.

## Deviations & notes

1. **login/pair now publish the machine-link config** (previously only
   identify/sign-out/boot did, despite the doc comment claiming all five).
   `transition` publishes on every change, per the "mutate ⇒ persist ⇒
   publish is ONE method" contract. Consequence: login with a parked
   machine id publishes a Some(config), and the webview's immediately
   following re-identify republishes the same config — one extra link
   reconnect at login. Harmless churn (the link is only just connecting);
   the alternative (skipping identical publishes) would break the deliberate
   same-config-reconnect semantics the reconnect regression test asserts.
2. Worktree note: `apps/desktop/dist` had to be copied from the main
   checkout for `include_dir!` to compile `guild-server` in tests (build
   artifact, untracked, not a source change).
3. Test runs need `GUILD_TEST_PG_URL` exported (known host prerequisite).
