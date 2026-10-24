# Idle inbox recovery and local clock updates

The parallel pi investigation supplied a deterministic Guild integration failure, retained
in the deliberately uncommitted `apps/server/src/test/wedge-repro.test.ts`.
A provider 404 is wrapped by the gateway as a retryable 502, leaving a run live
through the 2/4/8-second retry backoff. Inputs admitted then enter `pi.inbox`.
The pi-durable README's “Busy Conversations” contract deliberately leaves queued
items in the inbox after a failed run. The next input or queued write places them,
oldest first; restart/resume alone does not. This is documented native behavior,
not a pi-durable defect or permanent loss of placement.

Guild made that recovery path unreachable: its generating flag could remain true
while the native conversation was idle, and `WebChat` silently rejects normal-mode
sends while `busy || openGenerating` is true. Thus the action that would trigger
native placement was blocked by Guild's UI. Version 0.5.69 repaired damaged
projections and cancellation but did not close this integration gap.

## Contract and implementation

Guild deliberately chooses automatic continuation after failure, extending the
native next-admission contract. Clearing the flag and allowing a fresh normal
send would also restore native recovery, but would leave already accepted user
messages waiting for another admission. Guild instead places accepted queued
inputs without requiring another user action, including after restart. Its UI
work indicator therefore includes queued work while Guild arranges its run;
it is not a claim that pi-durable itself calls an idle inbox busy.

Guild applies an idle final boundary using public pi-durable APIs in a single
conversation transaction. A live run makes reconciliation a no-op. Otherwise,
all context writes and the first steer/follow-up are placed with their existing
submission identities in admission order. Stale context writes settle as stale;
resets preserve native head semantics. Only placed user inputs create a new
conversation-owned generation task. No synthetic prompt or replacement input
is created. Concurrent reconciliations cannot place an input twice.

Reconciliation runs after run endings, successful admission and harness startup.
The startup scan also includes stale generating flags. Archived chats are not
re-driven. Abort retains native withdrawal semantics, so reconciliation cannot
revive withdrawn inputs. The UI flag is derived from current nonterminal
generation tasks and queued submissions. Both submit gateways reconcile after
admission instead of blindly raising the flag after a fast run has finished.

`WorkedForBlock` owns its one-second state update and timer lifetime. The
transcript parent has no clock state. The memoized child counts while active,
stops on settlement/Stop, and preserves existing elapsed-time labels.

## Evidence

The new HTTP regression first failed in both worker modes with the input still
queued after all tasks ended. It now completes the same queued submission after
four upstream failures, without a new input or restart; generating then clears.
The worker-startup regression seeds an idle durable inbox and verifies the exact
submission completes after recovery. Boundary tests cover one-at-a-time order,
idempotence, steer/follow-up admission order, passive writes and stale heads.

A real Chromium fixture rendered the production clock beside 4,000 history
entries. From zero through five seconds, parent renders=1 and history renders=1.
Settling caused one expected parent/history render and no further timer updates.
The temporary fixture was removed after verification. This demonstrates removal
of the identified periodic transcript work; it does not measure every possible
cause of desktop lag.

## Deployment and final validation

Implementation commit: `7ff1865` on develop. Dev compose rebuilt and recreated
successfully; health reports 0.5.70 and the served bundle is
`index-BWjK-s0s.js`. An authenticated Chromium session loaded the original
large thread (56,400 characters of visible history), its composer was usable
and no Stop indicator remained. The database had no idle conversations with
queued submissions. A separate live verification turn completed `QUEUE_FIX_OK`,
its existing submission settled done, and generating cleared. That verification
thread was archived afterwards.

All six signed client artifacts published successfully with local/server
SHA-256 verification. Both localhost and the public dev updater serve 0.5.70
with four signed platforms. A public Windows installer download matched
`a4498203110abf6459f23d6446b01358c56558a0e6a661f0db042c5d6fc60dd0`.
No prod stack was changed.

Focused boundary/worker tests: 11 passed; failed-run HTTP regressions: both
worker modes passed. Frontend label tests: 58 passed; production build and
scoped server typecheck passed. Generated bindings are fresh. Full typecheck
still excludes the existing codemode unused-variable error and the unchanged
operator diagnostic's type errors.

The broad server run passed 463 tests across 47 passing files, with four
failed tests across four files. Three are the previously established WS/golden
assertions. The fourth was M6 cleanup: PostgreSQL refused to terminate a process
while dropping its disposable database. The same SPA assertion passed alone;
a later full M6 run passed all 26 tests (the starting commit also passed all 26).
An intervening M6 rerun saw extra telemetry collector requests. The broad WS
suite also timed out in teardown. Sandbox suites and the operator diagnostic
were excluded; no blanket claim that the entire repository suite is green.

The parallel session's `wedge-repro.test.ts` remains uncommitted. Its scenario-B
wording now describes native contract behavior; its original assertions and
execution logic are preserved as a baseline diagnostic. The separate
`queue-recovery.test.ts` asserts Guild's automatic-continuation policy.
