# Chat isolation — worker-per-chat: decided and building

Status: **implemented** behind `GUILD_WORKER_MODE=on` (`apps/server/src/worker/`). Dev runs worker mode; prod stays on the in-process supervisor until the worker-mode soak in PLAN.md's Next steps passes.

2026-10-15. Outcome of the durability incidents (the poisoned
`pi.live` document that SessionFailed every chat, the sealed session after a
transient Postgres failure, the SIGTERM drain). Requirement: **every chat is
fully isolated** — one chat's failure may never take down another chat, and
recovery must be automatic. DECISION 2026-10-15: build the
worker-per-chat model with IPC — “should be more scalable” — not gated on
upstream. M0 (the in-process supervisor) shipped first (`fe67fd8`) and stays:
it is the recovery primitive workers reuse.

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

## Architecture (as decided)

**The main server stops owning a harness.** Two harnesses over one storage
two schedulers adopting everything; but the admission path does not need a
scheduler — it needs to commit. So admission moves into the workers:

- Main server: HTTP + ws, the hub and machine links, member-socket fan-out,
  the spawner, and IPC routing. No `Harness.open` anywhere.
- Worker per active conversation: forks with a **scoped harness**
  (`ScopedDurableStorage` over one conversation — every scan forced onto the
  scope, by-id readers refusing foreign records; `2fe2d57`, proven by test:
  a scoped harness cannot adopt another conversation's pending task). Owns
  the bridge, codemode sandbox, executor envs; serves IPC: submit (with
  `requestId` dedupe), steer, stop, approve-resolve, compact.
- Frames need no IPC: the worker's bridge writes `thread_events` +
  `pg_notify` through the platform pool exactly as today — the main
  server's existing notify relay reaches the client sockets. IPC carries
  only control (submit/stop/approve/steer) and worker lifecycle.
- Spawn on first admission into a conversation with no live worker (the
  spawner forks, waits for readiness, then sends the submit), and on boot
  for every conversation with pending work (live tasks or queued
  submissions — a direct SQL scan, not a harness). Respawn on death.
- Idle reap: quiescence (no live tasks, no queued submissions, no in-flight
  IPC) plus a 10 min grace → clean close (pending stays pending, the same
  path as crash recovery, at a turn boundary so nothing converts to
  failed). The worker fleet then tracks “conversations active in the last
  10 minutes”, not “chats ever created”.

Isolation ladder (each step strictly widens the boundary):

1. ~~M0 supervisor, same process~~ **shipped** (`fe67fd8`) — heals transient
   failures in-process; workers reuse its reopen loop.
2. M2 worker processes — fault isolation, per-worker heap (this milestone).
3. Future: workers as sandbox microVMs (the sandbox-runner pattern extended
   to whole turns) — the “hypervisor” end state.

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

### M1 — scoped storage (shipped) + upstream proposal

Shipped: `ScopedDurableStorage` (`2fe2d57`) — scan-forcing + by-id refusal,
with the double-drive proof test. The upstream proposal to `earendil-works/pi`
(`Harness.open(storage, { scope: conversationId })` as a first-class API)
continues in parallel: when it lands, the adapter wrapper is replaced by the
framework's own guarantee, semantics unchanged.

Remaining questions for the proposal (informed by what the adapter relies
on): scan filtering by conversation; by-id record checks; the assumption
that a scoped session commits only to its scope (true because its ids come
from scope-filtered reads); `abandonOnRestart` re-drive inside a scope.

### M2 — the worker runtime (fork implementation shipped)

Shipped (`b314458`, flag-gated `GUILD_WORKER_MODE=on`, default off):

- `apps/server/src/worker/`: `main.ts` (the worker entry — scoped harness +
  bridge + codemode sandbox + executor envs for exactly one chat),
  `supervisor.ts` (the ForkSupervisor: fork, ready handshake with queued
  admission, heartbeat staleness reaper, respawn-with-backoff while the
  journal slice has pending work, SIGTERM-then-SIGKILL close),
  `protocol.ts` (the IPC contract: submit/withdraw/stop/compact +
  ready/heartbeat — frames and approvals deliberately ride Postgres).
- Routing: `GuildRuntime.submitTurn/withdrawQueued/stopChat/compactChat`
  branch on the supervisor; the server's `startOnce` skips the harness and
  runs boot recovery (`recoverFromJournal`) instead. The worker's runtime
  is the same class with `workerScope` set — its `openHarness` wraps a
  `ScopedDurableStorage`, and its `loadMapping` is skipped (the bootstrap
  owns the mapping).
- First-touch conversation bootstrap: a transient unscoped harness creates
  the conversation and writes the mapping, opened and closed without ever
  resuming (its adoption scan only resets running→pending rows, which the
  journal absorbs). Upstream wishlist: a no-adopt `Harness.open` or a
  harness-free `createConversation`.
- `mintId` is now an atomic increment of the durable_metadata counter —
  the in-memory watermark handed the same id to two processes once more
  than one harness existed. Mints are durable on return; the reopen test
  pins the stronger contract.
- Machine-bound chats throw a clear error in worker mode until the IPC
  dispatch proxy lands (follow-up).

Gates proven by `worker-mode.test.ts`: a turn completes through a forked
worker; two chats run in two workers; SIGKILL of one worker mid-turn
resumes its turn via respawn with zero `turn_error` while the other chat
streams undisturbed. Full suite at the pre-existing failure baseline.

### M2.5 — rollout + gaps before M3

- **Machine dispatch over IPC — shipped (`a94047b`).** The worker's env
  proxies machine-tool dispatch to the server's hub-backed registry over
  the fork channel (`worker/dispatch-proxy.ts`; timeoutMs + 30s grace so
  the server's authoritative outcome wins). Gate: a fake daemon on the
  parent hub proves worker env → IPC → hub frame → tool_result → settled
  turn. Machine-bound chats now serve in worker mode; `GUILD_WORKER_MODE=on`
  flipped on the dev stack and a live turn completed through a forked
  worker (soak started 2026-10-15).
- Idle reap (quiescence + grace) — designed, not yet built; workers run
  until closed.
- Approval-gate + compaction + steering flows exercised against the live
  worker-mode dev deployment (the gates' unit paths are journaled and
  should carry over; verify live).
- Prod flip after the dev soak stays clean.

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
