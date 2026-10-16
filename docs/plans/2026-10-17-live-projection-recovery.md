# Live projection recovery and machine tool lifetime

The affected dev conversation had a `pi.live` base `{}` followed by a delta
setting `nestedTools[0].output`. Applying that delta failed on every reopen.
Separately, its machine-bound shell command remained alive after Guild reported
an interruption. These are reproduced defects; the reported browser-wide freeze
has not been reproduced or attributed to either defect.

## Recovery contract

Upstream `pi.live` mixes presentation with run ownership. Repair cannot replace
it with `{}` indiscriminately: an active generation owns the placed submissions
that must eventually settle. The authoritative task records, placed submissions,
and assistant entries contain the information needed to rebuild that ownership
and the active tool round.

Before a harness opens, its Postgres storage validates the current live
projections within its conversation scope. An invalid path in a version-1
`pi.live` chain triggers transactional reconstruction. The storage archives the
original revisions and error in `live_projection_repairs`, writes a replacement
base at a new durable sequence, and leaves tasks, submissions, and transcript
entries unchanged. Queued inputs remain queued; placed inputs retain their run.
Active model/nested tool slots are rebuilt from task inputs and checkpoints;
partial display output is disposable. Unsupported document versions, other
kinds of corruption, and ambiguous run ownership fail explicitly without
rewriting evidence or guessing which input a run owns.

The same durable metadata lock serializes repair and ordinary commits. Live
projection readers retain their original revision watermark; a stale writer
cannot overwrite the repaired state even if its delta happens to apply there.
All live deltas are applied to the stored state for validation before admitting
the atomic write batch. The operator repair script uses this path and no longer
deletes live, inbox, codemode, or nested-call documents.

## Execution contract

A machine operation's caller cancellation travels through `MachineExecutionEnv`,
worker IPC (when enabled), the parent dispatch registry, and a `tool_cancel`
WebSocket frame addressed to the connection that accepted the call. The registry
also sends cancellation on its own deadline. Cancellation removes the waiter;
a late result cannot settle a different invocation. Worker death/close cancels
its pending parent dispatches.

The executor owns tool tasks by call ID and by socket lifetime. A cancel frame
aborts the matching task; socket teardown aborts and drains all remaining tool
tasks. Dropping shell execution closes the existing process-tree guard (Unix
process group / Windows Job Object), terminating descendants as well as the
shell. Unknown or completed cancellation IDs are harmless. Older executors
ignore the new frame and must be upgraded to enforce this lifetime; their
existing shell deadline still bounds execution.

## Verification

- Regression tests first demonstrated acceptance of invalid live deltas and
  stale writers, and failure to recover the incident's stored shape.
- Postgres tests cover atomic rejection, archived/idempotent repair, preserved
  queued inputs, reconstructed active-run ownership, active nested tool slots,
  refusal of ambiguous ownership, and stale-writer fencing.
- A worker integration test completes a turn, crashes the worker, introduces
  the incident's invalid delta, then starts a new worker and completes the next
  turn. Both inputs settle and both transcript answers remain present.
- Cancellation tests exercise real Chord contexts, worker IPC, deadlines, and
  late results. A Rust test starts a real shell and proves its descendant cannot
  write its completion marker after cancellation or connection teardown.
- Existing storage conformance, restart, resilience, worker, supervisor, and
  codemode suites are part of the validation run. Deployment/release results
  are recorded in PLAN.md when verified.

The app-shell tests now allocate a disposable database and explicitly point at
an absent web bundle for their fallback assertions. Their former default opened
the live dev database; the first broad validation run therefore applied the
additive repair migration and archived/rebuilt document 10976 before deployment.
The repair journal records that event. No transcript entry was removed.

Focused validation: 49 storage/lifecycle/worker tests passed, followed by 22
app-shell/recovery/cancellation tests after fixture isolation; all 88 Rust
app-server library tests and 52 protocol tests passed, and the desktop crate
compiled. The frontend production build passed. A scoped server typecheck
passed; the repository-wide check still reports existing errors in
`codemode.test.ts` and the other session's untracked `wedge-repro.test.ts`.
The final broad suite passed 487 tests and retained three baseline failures:
`ws-feed.test.ts`'s legacy live-frame expectation and the HTTP/WS golden
fixtures (`onboarded` and `last_activity_at`). These failures reproduce against
the starting implementation. The task's operator diagnostic test was preserved
and excluded; sandbox integration suites require their separate harness.

A final atomicity regression also covers a valid first-document delta followed
by an invalid second-document delta in one rejected batch. Validation uses
immutable application so the first document's cached state cannot acquire
changes that never committed. The regression failed before that correction.
