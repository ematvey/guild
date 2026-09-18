# REPORT — GenerationTable + executor funnel refactor (branch `implement/funnel`)

**VERDICT: CLEAN** — full suite green before and after, no test modified to
pass except two that moved with their code (noted below), no out-of-scope
crate touched, four commits matching the four steps.

Verification (all run to completion, all green):

- `cargo test -p guild-server --features test-support` — **334 passed, 0 failed** (7 ignored, pre-existing)
- `cargo test -p protocol` — 9 passed, 0 failed
- `cargo build` (default members) — OK, no new warnings (remaining warnings pre-exist: codex-execpolicy dead code, ws.rs private-interface lint, admin.rs dead handler)

Test counts before/after (baseline measured in a clean worktree at the base
commit `a436369`, with `GUILD_TEST_PG_URL` set — the DB-backed tests fail
environmentally without it; that pre-existing behavior is unchanged):

- before: 321 passed / 0 failed (109 lib + 212 integration)
- after: 334 passed / 0 failed (+8 GenerationTable, +2 funnel, +3
  turn-derivation; 3 dispatch tests moved gateway→funnel with no count
  change; no existing test deleted)

## What changed per step

### 2a — GenerationTable (commit f1096bb)

`state.rs` gains `GenerationTable` (verb-only): the `generations` map moves
off `AppState`'s raw `Mutex<HashMap>`. `ActiveGeneration` and `PendingTool`
moved from gateway.rs into state.rs; the map's pending-tools become private
to the table. Verbs: `try_begin` (atomic reserve-or-409 — the old
`try_begin_generation`), `attach` (get-or-create — the old
`ensure_generation`), `handle`, `is_generating`, `cancel_flag` (the old
`generation_cancel`), `remove`, `set_pending_tool` / `clear_pending_tool` /
`pending_tool` / `owns_pending_tool` / `has_pending_tool` /
`set_pending_tool_connection` / `stale_machine_calls` (reconcile scan),
`active_streams` (feed subscription), `buffers` (delta-signature check), and
`take_buffers_for_capture` — the feed.rs capture contract is now code: the
capture async mutex (old `AppState.thread_sync`, field removed), the buffer
read locks held across the event read, and the watermark allocated last live
inside the method; it returns one `CaptureView` (text, thinking, generating,
events, seq). Callers (gateway, feed, ws, restate, test support) swapped raw
lock choreography for verbs. New tests (TDD, written first): table verb
lifecycle, concurrent `try_begin` atomicity, and
`capture_during_commit_never_shows_a_step_twice` — a writer committing
assistant steps against three concurrent captures, pinning the no-torn-view
invariant (a step's text never appears in both buffer and log) and
seq-never-trails-events.

### 2b — funnel module (commit b05a9d6)

New `worker/funnel.rs`. Moved wholesale from gateway.rs:
`note_pending_tool`, `dispatch_pending_tool` (KV claim), 
`restore_dispatch_connection`, `clear_pending_tool`,
`reconcile_machine_tools`, `pending_tool_exists`, `spawn_machine_watcher`,
`spawn_stop_watcher`, `spawn_stop_approval_watcher` (moved beyond the
plan's list because the plan also requires gateway to lose
`APPROVAL_TIMEOUT`, which this watcher consumed), and the
`CLIENT_TOOL_TIMEOUT` / `APPROVAL_TIMEOUT` constants (moved from restate.rs
— their consumers, the watchers, live here now). restate.rs, ws.rs and
test support re-point at the funnel. Tests: the three dispatch tests moved
from gateway's test module into funnel's (**moved, not deleted** — they
tested dispatch semantics through the old interface's module paths:
dispatch-reservation-survives-state-loss, workdir-on-dispatch-frame ×2),
plus two new tests: stop-during-suspend resolves through the durable
resolver (mock ingress) and the note→dispatch→clear cycle with the watcher
signal.

### 2c — the three arms re-point (commit 4a82bf0)

`funnel::suspend(ctx, state, tx, org, model, chat, call, Executor) -> 
ToolResultPayload` is the worker port: exec-policy gate → approval gate →
then either the awakeable + KV dispatch claim + watchers + durable 5-minute
timeout (machine executor) or the journaled inline run (server-side).
`Executor` is the spec's taxonomy as a type: `Desktop { machine_id,
machine_label, workdir }` | `Sandbox` | `ServerLocal { dir }`; `sandbox_dir`
derives the per-chat sandbox path inside the funnel. In restate.rs:
`sandbox_tool_step` and `server_local_tool_step` are two-line suspend calls;
`client_tool_step` keeps only the journaled machine resolution (bound /
origin auto-bind / sandbox fallback) and the offline fail-fast — everything
from the exec-policy gate down is the funnel's. The approval gate
(restate.rs `approval_gate`) and `exec_policy_gate` stay as they are and
feed the funnel's suspend. Journaled step order, payload texts and frame
shapes are byte-identical (code moved verbatim), so replay determinism is
preserved; the gate-orchestration paths inside a Restate context
(exec-policy deny, approval denied, 5-min timeout, duplicate completion)
remain covered by the live E2E per the repo's convention for workflow
internals — the funnel's ctx-free machinery (dispatch, both watchers,
resolution, clear) is covered by the module's tests.

### 2d — cross-imports die + turn.rs (commit c702f55)

New `worker/turn.rs`: `build_turn_text`, `load_media_map`, `MediaRef` /
`MediaMap`, `media_parts`, `modality_of` (with its private helpers), and
`enforce_quota`. gateway.rs's queue_user_turn and restate.rs's generate now
derive through worker::turn. The restate→gateway import at restate.rs:15 is
gone (`enforce_quota` moved; `ensure_generation` already died in 2a);
gateway's imports of `load_media_map` / `build_turn_text` /
`CLIENT_TOOL_TIMEOUT` / `APPROVAL_TIMEOUT` / `ApprovalReq` are all gone —
the approval-decision forward moved into the funnel
(`funnel::forward_approval_decision`), and `persist_assistant_step` moved
to state.rs next to the table (it is the commit-side twin of
`take_buffers_for_capture`: write locks held across the durable append, so
capture and commit are the two halves of one contract). restate.rs now
imports nothing from http::gateway. `enforce_quota` is re-exported from
gateway (`pub use`) so the out-of-scope HTTP callers (agents.rs, openai.rs)
keep their path untouched. gateway.rs went from 1671 lines to 993 (−678).
Kept deliberately (not in the plan's deletion list): gateway's references
to `ChatRunPayload`, `CompactReq`, `workflow_schema_version` — the HTTP
layer addressing the workflow's request surface. New tests (TDD): three
turn-derivation tests (inline cap exact at 80 000 chars with the
`…[truncated]` marker, the UI strip-marker shape, modality notes gated by
route modalities, request-id filtering).

## Files touched

In-scope: `crates/server/src/{state.rs, http/gateway.rs, http/feed.rs,
http/ws.rs, worker/restate.rs, worker/funnel.rs (new), worker/turn.rs (new),
worker/mod.rs (module decl)}`; `crates/server/tests/{chat_control.rs,
turn_derivation.rs (new)}`. Not needed: `http/mod.rs` (no routing change),
`crates/server/src/lib.rs` (worker is already a `pub mod`; new modules are
under `worker::`).

## Deviations (and why)

1. **`crates/server/src/test_support.rs`** (22 lines) — outside the listed
   scope. Unavoidable: it reached into `state.generations`'s raw map and
   gateway's moved functions; it now uses the table verbs and the funnel
   functions. Its public test API (note_generation, generation_cancel,
   note_client_tool, note_watched_client_tool…) is unchanged, so no test
   file needed edits for it.
2. **`worker/mod.rs`** — two `pub mod` lines (funnel, turn). Listed scope
   said lib.rs for module decls; the decls belong to worker/mod.rs, which is
   the same kind of change.
3. **`spawn_stop_approval_watcher` moved in 2b** — not in the plan's move
   list, but 2d requires gateway to lose `APPROVAL_TIMEOUT`, and this
   watcher was its remaining consumer. Same watcher family, one home.
4. **`CLIENT_TOOL_TIMEOUT`/`APPROVAL_TIMEOUT` moved in 2b**, not 2d — the
   watchers that consume them moved in 2b; leaving duplicate constants
   behind for one commit would have been worse.
5. **`persist_assistant_step` moved to state.rs in 2d** — not in the plan's
   list, but it is the commit-side twin of `take_buffers_for_capture` and
   the last worker→http::gateway import; the capture-during-commit test
   lives on both halves of that contract.
6. **Tests moved with their code** (declared per the task's rule): the
   three gateway dispatch tests → funnel's test module (2b); their
   assertions are unchanged.

## Watch items honored

- Replay determinism: every journaled step moved verbatim (same order,
  same payloads); the funnel's Desktop path issues exactly the sequence
  client_tool_step used to.
- The feed.rs:546 capture-atomicity comment is now `take_buffers_for_capture`
  + `persist_assistant_step` in state.rs, guarded by the
  capture-during-commit test.
- `submit_turn` remains gateway's front door (routes, headers, queue/steer
  logic untouched).

Not done (per instructions): no deploy, no PLAN.md edits, no
protocol/app-server/guild-core/desktop changes, no bindings regen.
