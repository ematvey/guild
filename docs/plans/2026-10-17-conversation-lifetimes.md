# Conversation lifetimes, recovery, and queued steering — 0.5.72

This implements the follow-up review of `a4527a8`. Pi Durable and its related
packages remain pinned to 1.3.0. The change addresses the six reproduced
findings, the inspected lifecycle issues, and the architecture/style work
in `/home/user/guild-audits/pi-durable-2026-10-17/FOLLOWUP.md`.

## Ownership and admission

`ConversationHost` owns a candidate harness, storage, and watches as one
lifetime. Initialization failures dispose the whole candidate, including a
scheduler already resumed. Replacement closes the preceding lifetime and
ignores failure notifications from superseded owners. Runtime shutdown
joins initialization/reopen work and closes cached conversation state.

`ConversationDirectory` coalesces concurrent first touch and acquires a
per-chat Postgres advisory lock before checking/creating the mapping.
Creation is no longer a last-writer-wins upsert. The lock spans the durable
creation and mapping insert; a process crash between those operations can
leave an unreachable ownerless conversation, but cannot return two mapped
owners to callers. Mapping creation is serialized within each process so
concurrent new chats cannot reserve every pooled connection while waiting
for durable commits. A failed unlock destroys the connection rather than
returning a possibly locked connection to the pool.

Conversation admissions serialize configuration/discovery and submission.
Stop cancels both active preparation and waiting admissions, independently
of the admission queue; a delayed discovery cannot admit work after Stop.
Cancelled preparations settle their accepted command, remove an unplaced
queued echo, and return 409; IPC preserves that error status.
MCP discovery combines that signal with a 20-second total deadline and
processes at most four servers at once, retaining deterministic ordering.

## Worker lifecycle

All callers await the same ready handshake. Readiness has separate starting,
ready, and failed states. A failed readiness deadline kills the child;
a successful handshake cannot later expire. Pending-work lookup errors
retry instead of being interpreted as idle. Backoff survives replacement
PIDs and resets after a stable interval or deliberate idle retirement.

The supervisor defaults to at most **16 workers**, configurable with
`GUILD_WORKER_LIMIT`, and retires idle workers after **five minutes**
(`GUILD_WORKER_IDLE_MS`). Retirement verifies authoritative work and pending
requests, waits for process exit before replacement, and escalates to
SIGKILL after five seconds. Projection-only boot workers retire immediately
after catch-up. Boot recovery runs with four acquisition loops in the
background, so a slow conversation does not hold the HTTP listener closed.
The supervisor joins recovery and spawn operations during shutdown.

Workers verify schema versions; only the server applies platform/durable
migrations. Scoped conversation discovery reads its single conversation
rather than scanning all conversations and filtering them in each worker.
Machine environment construction shares one dispatch path for worker and
in-process execution. Model refresh is limited to the worker chat's org.

`platform/store/work.ts` supplies startup/respawn predicates for live tasks (including
`completing`), queued inputs, entry backlog, unprojected failure outcomes,
and unsettled submission reconciliation. UI generating remains based on
agent work rather than projection maintenance.

## Durable projection and live presentation

`TranscriptProjection` owns durable entry translation and backfill.
`ChatBridge` owns live buffers, frames, and command presentation. Durable
writes receive an explicit source identity rather than consulting a
mutable `sourceEntry` flag. ThreadStore accepts named projection inputs;
ordinary appends no longer carry optional projection flags.

`ConversationRecovery` reconciles submissions with a persisted high-water
position plus tracked queued/placed submissions. It reads newly admitted
records and transitions of unsettled records, avoiding a full history scan
on each run ending. Acknowledgement and the high-water update commit
atomically. Entry backfill remains paged independently of active context.

Failed/faulted/orphaned generation outcomes are reconciled from task
records, even if a live task_failed event was missed, overflowed, or failed
to persist. The error row and task projection mapping commit atomically.
An index isolates generation failures from successful task history. Legacy
matching is limited by a persisted pre-upgrade task boundary, preventing a
new identical error from adopting an unrelated old error. A failed append
leaves the task eligible for retry.

The bridge resolves a run's command through the durable submission request
ID, which exists before the HTTP path records invocation_id. This keeps
live generation IDs equal to the acknowledged command ID. Feed closure
runs after queued terminal frames and explicitly schedules the final full
view. These changes fix the previously failing WS terminal-state scenario.
Handled entry IDs and spilled pointers are cleared at run/lifetime changes.

## Model attribution and tool surfaces

Provider request attribution uses the durable provider-session ID forwarded
by Pi, resolving the actual chat/conversation/owner for each HTTP request.
There is no mutable per-org "latest turn" slot. Resumed generation and
compaction use the same identity. A speculative turn counter is no longer
sent: absent turn attribution is preferable to another run's turn number.

Dynamic registry extensions are scoped to the conversation, so provisioning
another chat cannot replace its declarations. Declarations refresh on
admission and resume, with no independent ten-minute TTL refresh. Guild's
policy is **latest successfully configured conversation settings**: a queued
input can change the current run's next provider request; it does not carry
a frozen private model/tool configuration for later placement. Authorization
and secrets are checked fresh at execution time, even while declarations
remain stable. Tool removal intentionally yields an unavailable tool rather
than reviving an obsolete capability. Transient store/provisioning failures
propagate and retry before resumed execution; they are not persisted as a
successful empty selection. Worker ownership isolates affected chats.

MCP names use `mcp<server-name-length>_<server-name>_<tool>`, removing the
underscore ambiguity while retaining readable names. Duplicate final names
are rejected. Fresh admissions and resume reconfigure selections to the
new names; old scripts using previous generated names must be regenerated
from the declared surface. User MCP tools are replay-unsafe, so interrupted
external calls are not silently replayed under the renamed surface.

Tool registrations are type-checked rather than cast wholesale to
ToolRegistration. External schemas and JSON metadata have a validation seam.
The unused preparation action field and extension cache are removed.
Deterministic argument serialization is shared. Guide extraction uses
bounded asynchronous archive reading, no temporary full extraction, and a
64-entry digest-keyed text cache. Comments at the changed seams describe
current ownership and configuration behavior.

## Storage observability and receipt retention

Storage reports commit count, accumulated metadata-lock acquisition time,
commit duration, retained acknowledged receipts, and reclaimed receipt count.
The host logs those diagnostics when its storage lifetime closes. These
measurements expose the shared metadata lock rather than suggesting that
more chat workers make commits parallel.

Only receipts for invocations this instance has positively acknowledged are
eligible for deletion, in batches of 64 and on graceful close. Ambiguous or
failed invocations are retained. No time-based cutoff is used, and old/crash
residue is not deleted without proof that its invocation cannot retry.
This bounds ordinary successful-stream receipt growth while preserving
ambiguous-COMMIT recovery. It deliberately retains unproven crash residue;
there is no unsafe TTL garbage collector. Existing document checkpointing
and Pi's partial-commit throttle remain in place; no storage-protocol or
stream-throttling change was made without measurements.

## Queued message → steering

Queued chips expose **Steer now**. The action calls:

```http
POST /api/v1/threads/:chatId/pending/:messageId/steer
```

The normal chat access check applies. The host atomically changes the
existing InboxDoc item's mode from followUp to steer, retaining submission,
message, content, and attachment identity. It is idempotent while still
queued. Placement/withdrawal winning the race returns 409. An admission
that has not yet acquired a submission also returns a retryable 409.
Steering is consumed at the next tool boundary; if the run already ended,
normal idle-inbox reconciliation makes it runnable.

Inbox snapshots and inbox_update events reconcile chip mode, so a process
failure between the durable edit and the platform echo update heals on
reopen. The desktop receives the updated mode through the ordinary thread
feed; the action adds no navigation state. The reducer preserves queued status when
an incremental update changes only the mode; a fresh sequence alone no longer
mistakes promotion for delivery. A regression covers queue → steer → delivered
with exactly one message throughout.

## Validation and delivery

New checks cover candidate disposal after resumed initialization failure,
first-touch concurrency, Stop during admission, ready-handshake races,
readiness expiry, transient recovery probes, persistent backoff, projection-
only worker retirement, concurrent model-session tracing, task failure
reconstruction, receipt cleanup, and queued-to-steering conversion in both
worker modes. Steering checks assert stable submission identity and a shared
answer with the active run, plus 409 after placement.

The restart fixture closes the actual previous runtime and app before
opening a fresh owner, and asserts pending work remains. Its old seeding-pool
close left app1's scheduler alive and manufactured concurrent owners;
SIGKILL recovery remains covered by real forked-worker tests. The fast-turn
ack test permits a run to have already started/completed, then still verifies
terminal command/usage/output. Trace checks explicitly assert the unknown
turn sentinel and the correct durable conversation identity.

Golden fixtures explicitly include the current onboarded and chat
last_activity_at fields. Their exact comparisons remain enabled. The WS feed
case now checks the actual acknowledged generation's terminal and final
view; it is not replaced with a weaker assertion.

Server typechecking passes. The focused final lifecycle, two-connection pool,
durable-contract, and queue checks pass: 27 tests across three files
(`bigjob-20261016-225043-guild-directory`). Desktop validation passes 353 tests
across 27 files plus TypeScript/Vite build
(`bigjob-20261016-224411-guild-desktop-steering`). The MCP HTTP fixture accepts
bodyless transport requests instead of parsing them as JSON.

The broad server run passed 537 checks; its newly added pool regression
reproduced the old cached directory implementation while the focused run
verified its fix. A fresh source-frozen broad run is in progress. Terminal
suite, dev deployment, bundle, desktop updater, and live verification results
are recorded here after they complete.
