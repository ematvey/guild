# Idle inbox recovery and local clock updates

The parallel pi investigation supplied a deterministic second failure, retained
in the deliberately uncommitted `apps/server/src/test/wedge-repro.test.ts`.
A provider 404 is wrapped by the gateway as a retryable 502, leaving a run live
through the 2/4/8-second retry backoff. Inputs admitted then enter `pi.inbox`.
On `model_error`, pi-durable clears the run but applies no final inbox boundary;
resuming task scheduling alone cannot place those queued inputs. Version 0.5.69
repaired damaged projections and cancellation but did not close this hole.

## Contract and implementation

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
cause of workstation lag.

Deployment and final validation results will be recorded below.
