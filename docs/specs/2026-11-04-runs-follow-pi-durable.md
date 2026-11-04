# Runs follow pi-durable — findings and plan

Status: option A implemented (branch `spike/pi-durable-runs`); B and C
undecided.

Implementation of A:

- `agents/run-hook.ts` is a `beforeRequest` hook on the generation task.
  It reads the run's inputs from `pi.live.run` and calls
  `AgentRunLifecycle.runStart`, before every model request of the run.
- The first call takes over the queued rows whose id is one of the inputs'
  request ids, else opens a `message` run for the submitting member. A row
  already `running` is the run's own (a resumed run).
- The bridge's `run_end` calls `runEnd`, which settles every running row
  from the run's last answer (`terminalAssistantSince`). It also settles
  queued rows of a run that ended before any request, and records a failed
  run that had none.
- `startThreadRun` (spawn, send, routines) creates its row `queued` and
  submits under the run id. Submit and the agent turn route no longer
  pre-create rows. Delivery no longer opens runs or takes a lock.
- The subagent tools read the calling run when they run, not at
  provisioning.
- A run's first request can arrive before the previous run's `run_end`
  (child results waiting in the inbox start the next run at once). Inputs
  without the open run's inputs are another run, so `runStart` settles the
  open rows first and the late `run_end` only adds a failure; a run whose
  inputs grew (a steer taken into it) stays one run.

## Question

Guild keeps its own run model on top of pi-durable:

- `agent_runs` rows, opened at submit or delegation and closed when an
  assistant message without a tool call appears (`agents/lifecycle.ts:104`);
- a hand-built child-result delivery (`agents/delivery.ts`) with an
  advisory lock, a re-delivery sweep and an orphan sweep;
- a stop path that withdraws queued child results and writes them back.

Can all of this be dropped in favour of pi-durable's own semantics: the
turn as pi-durable's run, and subagents as task-owned conversations
(pi-durable README, "Abort and Subagents"; example
`23-subagent-background.ts`)?

## Findings

Citations into pi-durable are to 1.3.0 (`packages/durable`, the same
source as the vendored copy).

### 1. pi-durable's turn is `pi.live.run`, not a task

- A run is named by `pi.live.run`. While generation and tool rounds hand
  work to each other, `taskId` moves to each next generation
  (`docs/spec.md:2318-2323`, `4163-4166`). One turn spans many
  `pi.generation` tasks, so "one turn = one task" does not hold.
- A steer taken at the post-tools boundary joins the current run. Inputs
  waiting at the final boundary start a **new run** with those inputs
  (`spec.md:2404-2411`). The bridge sees this as `run_end` then
  `run_start`.
- Finished tasks remain in storage as small records (`spec.md:1982`). But
  they are per request or tool round, and usage is tracked per
  conversation (`pi.usage`) and per assistant entry, not per turn.

**Consequence:** the bridge's `run_start`/`run_end` is exactly
pi-durable's turn. If `agent_runs` opens and closes on those events, the
gap where a run record closes while its turn continues cannot happen. An
input arriving at the final boundary becomes a new run with its own
answer. This change does not depend on the subagent question below.

### 2. Native subagent ownership needs one harness for the whole tree

- "One process owns a storage at a time; there is no cross-process
  locking" (README:682). There is no lease or claim. On open, a scheduler
  adopts every live task it can scan (`scheduler.ts:288-310`).
- A harness never sees another harness's commits. Storage has no
  subscribe or notify (`types.ts:1059-1119`). Waits are in-memory waiters
  (`submissions.ts:85-97`), and inbox and live documents are cached per
  session.
- Abort cascade and "the parent is idle only once the child is" work only
  when one scheduler sees the whole ownership tree (`spec.md:2036-2041`).
- Guild's worker mode runs **one harness per chat**, each in its own
  process, behind `ScopedDurableStorage`. That storage hides every other
  conversation (`storage/postgres/scoped.ts`). A child chat runs in a
  different worker from its parent. Example 23's reporter calls
  `runtime.conversation(child)`, which would return `undefined` under the
  scope.
- No conversation is created with task ownership today. All are
  `ownerless`, and the tree lives in `agent_threads.parent_thread_id` and
  `agent_runs.parent_run_id`.
- Native reporting is not better at Stop: a parent's Esc withdraws a
  queued follow-up as `unanswered`/`aborted`, and the report is lost (the
  example says so). Guild's write-back keeps it.

**Consequence:** native ownership is possible only if a whole agent tree
runs in one harness, which means one worker process per root thread. The
alternative is an upstream scoped/multi-harness pi-durable, which is
already noted as an upstream ask in `scoped.ts`.

### 3. What the run id carries today

The `agent_runs` id is more than a status row. It is also:

- the ClickHouse trace id;
- the idempotency key of a child result (`submissions.request_id`);
- the routine occurrence link;
- the conflict-journal key (`agent_workspace_turns.run_id`, NOT NULL);
- the `/runs/<id>` URL;
- `run_id` in `child_spawned`/`child_result` payloads.

It is used in ~26 server files, the `agent_run` frame, and the desktop
Activity, Trace and Routines views. Whatever replaces the row must keep a
stable per-turn id.

## Options

**A. Make `agent_runs` a projection of pi-durable's run.** (Do now.)

- Open or adopt the row at the bridge's `run_start`; settle it at
  `run_end` from the run's last assistant answer. Drop the "first reply
  without a tool call closes the run" rule.
- A row created early by delegation or a routine (queued) is adopted by
  the child's first `run_start`. A resumed run after a restart adopts its
  open row (the bridge synthesizes `run_start` from the snapshot).
- Usage and summary come from the run's assistant entries.
- Fixes the run-record gap. It keeps every consumer, id and URL as they
  are.

**B. One harness per agent tree, then native ownership.**

- A worker owns a root thread and every descendant conversation, and
  `ScopedDurableStorage` widens from one conversation to a conversation
  tree.
- Spawn creates the child with `ownership: {kind: "task"}` under a
  background anchor; a reporter task submits the answer to the parent.
- Removes `delivery.ts`, the re-delivery and orphan sweeps, the advisory
  lock, the cancel-cascade code and the stop write-back hack. It gains
  pi-durable's abort cascade and idle semantics.
- Costs:
  - A big tree shares one process. Worker isolation becomes per tree,
    not per chat.
  - Existing child threads are ownerless; they keep the current path
    until closed, or are migrated.
  - Stop drops queued reports unless a write-back is kept.
  - Two delivery paths during the transition.

**C. Keep worker-per-chat; wait for an upstream scoped harness.**

- Keep a thin cross-process delivery, like today's.
- Revisit B when pi-durable supports several harnesses on one storage.

## Recommendation

1. Do A now. It is independent of B and C, removes the inferred
   "finished" rule, and fixes a real loss of results.
2. Decide between B and C as a product question: is a whole agent tree
   in one worker process acceptable (isolation, memory, crash blast
   radius)? If yes, B removes most of Guild's own run machinery. If not,
   C, and raise the multi-harness ask upstream.
