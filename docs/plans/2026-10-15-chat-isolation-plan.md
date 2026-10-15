# Chat isolation — per-chat durable workers under a supervisor

maintainer, 2026-10-15. Outcome of the durability incidents (the poisoned
`pi.live` document that SessionFailed every chat, the sealed session after a
transient Postgres failure, the SIGTERM drain). Requirement: **every chat is
fully isolated** — one chat's failure may never take down another chat, and
recovery must be automatic. Direction settled in discussion: worker processes
per chat, supervised, built on pi-durable's own recovery model rather than a
hand-rolled daemon. Discussion only preceded this doc; implementation starts
at M0.

## The framework facts this stands on (verified in pi-durable source)

- One storage ↔ one `Harness.open` ↔ one scheduler. At open/resume the
  scheduler scans **every** live task and queued submission across **all**
  conversations and adopts them; running tasks reset to pending and re-drive.
  Conversations (and their per-conversation agents — the `pi.agent` document)
  live *inside* the harness; per-chat variation happens through harness-level
  callbacks (`env(conversation)`, per-org model providers, the registry).
- Two harness opens over one storage are unsupported: two schedulers would
  adopt everything and re-drive each other's work. Separate harness opens per
  chat therefore need an upstream scoped-harness API.
- The recovery loop is first-class: a storage error closes the Harness by
  itself, `harness.closed` settles with `reason`, and the documented host
  pattern is `closed.then(end => { if (end.reason === "failed") reopen() })`
  — reopen storage, `Harness.open`, `resume()`. Commits are atomic;
  resubmission with the same `requestId` dedupes. Close/crash leaves work
  pending; `replay: "safe"` tools rerun, others hand the model an
  `interrupted` result with the committed output.

## Architecture

Main server (unchanged surfaces): HTTP + ws, durable **admission**
(submit / withdraw / stop / approve-resolve — all atomic commits with
`requestId` dedupe, safe from any process), the hub and machine links, and
member-socket fan-out.

Worker per active conversation: a child process of the server container that
owns a **scoped harness** — one conversation's tasks, submissions, documents,
and entries only — plus the bridge (thread_events / turn_commands /
generating projections), the codemode sandbox, and its executor envs.
Machine dispatch and oversized-result spill proxy to the main server over
IPC; live frames flow worker → main server → member sockets.

Lifecycle, driven by the journal:

- **Spawn** on the first admission into a conversation with no live worker
  (submit, steer, approve, compact), and on server boot for every
  conversation with pending work (the resume-on-boot scan replaces today's
  `resume()`-everything).
- **Run** until the conversation is idle — no live tasks, no queued
  submissions — plus a grace window, then exit cleanly. A clean exit leaves
  pending work pending (pi-durable close semantics); the next touch resumes.
- **Recover** from any crash by respawn + resume; the client sees the turn
  continue, not an error. A worker crash never touches another chat.
- **Reopen** (in-worker, pi-idiomatic) on `harness.closed` with
  `reason: "failed"` — transient storage errors cost a reopen, not the
  process. Reopen storm → bounded backoff, then the worker exits and lets
  the spawner's respawn backoff take over.

Isolation ladder (each step strictly widens the boundary):

1. M0 supervisor, same process — self-healing, shared heap.
2. M2 worker processes — fault isolation, per-worker heap.
3. Future: workers as sandbox microVMs (the sandbox-runner pattern extended
   to whole turns) — the "hypervisor" end state. Out of scope here; the
   worker boundary is what a later VM sweep would wrap.

## Milestones

### M0 — supervisor: the in-process reopen loop

`Harness.open` → attach `harness.closed` handler: on `reason: "failed"`,
log the failure, re-open the storage handle and harness, re-attach all
watches, `resume()`, keep serving. Exponential backoff between attempts
(reopen, 1s, 5s, 30s, cap), reset after 10 minutes of stable running.
A reopen that itself fails keeps backing off; the server stays up and
admission still works (commits from the HTTP path still succeed or queue)
— no more "wedged until redeploy".

Also in M0: the boot path stops re-driving *everything* blindly —
`resume()` stays (it is what re-drives pending work) but the reopen loop is
the only thing that recreates the harness. Watches re-attach on every
reopen (the current startup order — watches before resume — applies).

Gate: a fault-injected storage error (a thrown commit inside a test)
settles the harness; the supervisor reopens; an in-flight turn resumes and
completes; a second fault one minute later reopens again. No manual
restart.

### M1 — the upstream scoped-harness proposal

File `earendil-works/pi` (pi-durable is experimental; the API moves):
`Harness.open(storage, { scope: conversationId })` — the scheduler adopts
only in-scope tasks and submissions; document reads/writes and id minting
stay global (they are transactional and safe cross-process today).

Questions the proposal must answer:

- Scoped scheduler: the `open()` scan and the queued-submission scan filter
  by conversation. Adopting *only in-scope* running tasks keeps the
  reset-to-pending semantics intact.
- Is a scoped harness + an unscoped harness (the server's admission path)
  over one storage a supported combination? Admission only commits
  submissions/entries; it never resumes — the framework's
  "resubmitting with the same requestId finds the submission already
  admitted" rule is what makes this safe on paper.
- `abandonOnRestart` and worker reaping: a clean close is preferred at idle;
  hard death mid-codemode relies on the documented restart abort — confirm
  a scoped harness re-drives it identically.

Fallback if upstream declines or lags: a Guild-owned scoped storage adapter
(scan filters by conversation). Experimental flag, never default — the
scheduler's global scans are the invariant we would be narrowing without
the framework's promise.

Gate: a decision (accepted API shape or the fallback design) written back
into this doc.

### M2 — the worker runtime

- `apps/server/src/worker/`: the worker entry (scoped harness + bridge +
  codemode sandbox + executor env resolution), IPC surface (frames out;
  resolve/stop/withdraw/compact in), idle reap (quiescence watchdog, 10m
  default), heartbeat so the spawner can detect a wedged worker.
- Spawner in the main server: registry of live workers (in-memory + a
  `durable_metadata`-adjacent row for boot reconciliation), spawn/kill,
  respawn backoff per conversation, boot scan spawning workers for
  conversations with pending work.
- The bridge moves into the worker unchanged (it already writes only its
  conversation's projections); `chats.generating` flips move over IPC.
- Approval gates: the waiting task lives in the worker; the approval API
  resolves it over IPC. The gate's idempotent re-append and judge verdict
  reuse (2026-10-15 fixes) carry over as-is.
- Machine dispatch: `MachineExecutionEnv` in the worker calls the main
  server's hub over IPC (the hub keeps machine links and the exec-policy
  matcher).
- Live frames: the worker's bridge emits over IPC into the main server's
  stream sink (the current `setStreamSink` seam).
- Resource caps per worker (`--max-old-space-size`, and container-level CPU
  shares later); a worker OOM kills one chat, which resumes.

Gate: the full pipeline runs against a worker — submit → queue → place →
deliver → approval → answer; kill -9 the worker mid-turn → respawn → the
turn completes; two conversations run in two workers and one's crash leaves
the other streaming; the restart-resume test (now worker-shaped) passes.

### M3 — worker-per-chat as the default + cleanup

- All chats (plain + agent sessions + machine-bound) serve through workers.
  The in-process harness path is removed; `runtime.ts` shrinks to
  admission + routing.
- The deploy story: deploys stop touching turn state entirely (the main
  server no longer owns runs); worker binaries version with the server
  image; a version-mismatch worker is respawned from the new image on its
  next touch (resume semantics unchanged).
- Ops: worker liveness + respawn counters, reopen counters, alert on
  respawn storms; the durable-repair script learns to quarantine a single
  poisoned conversation (delete its documents) without touching others.

Gate: a full deploy during active turns — zero interrupted answers, zero
client-visible errors, chips deliver; soak on both stacks.

## Risks

- Upstream scoping lands late → M2 runs on the adapter-level fallback, with
  the upstream proposal kept alive; the worker boundary (spawn/route/reap)
  is identical either way.
- Admission-without-runner races: a submit lands, the worker spawns a
  moment later — pi-durable's queued-submission adoption (submission
  waiting → placed at the next resume) already covers "admitted before the
  runner exists".
- Two spawners (server restart during worker spawn): the registry row is
  committed before spawn; boot reconciliation kills orphans by pid/heartbeat
  staleness.
- Projection code moves but stays the same shape — the reconcile gap
  (projections vs journal) remains a known debt; M2 keeps the failures
  loud (no swallowed catches) so drift surfaces as errors, not hangs.
