# Agent-to-agent — implementation plan

Date: 2026-10-22. Status: planned; no code yet.

Spec: `docs/specs/2026-10-22-agent-to-agent.md` (21 decisions). This plan says
how to build it and in what order. It does not repeat the reasoning.

## What changes

- A spawn creates a **thread** in a tree, not a special run.
- The child reports by **ending its turn**; the delivery is a steer input into
  the parent and drains as one message per boundary.
- Files travel as **attachments on messages** in both directions.
- `delegate`, `release_artifacts`, `transferArtifacts`, the 16 MiB staging
  branch, `/tmp/delegations`, and the dead `outboxFiles` helper are removed.

## Work packages

Each package is one subagent task. Dependencies are strict: do not start a
package before its prerequisites are merged.

### WP1 — Schema and types (blocks everything)

- Migration `apps/server/migrations/0087_agent_to_agent.sql`:
  - `threads`: `parent_thread_id UUID NULL REFERENCES threads(id)`,
    `depth INT NOT NULL DEFAULT 0`, `closed_at TIMESTAMPTZ NULL`,
    `kind` check gains `'delegated'`.
  - `thread_events`: kind check gains `'child_result'`,
    `consumed_by_run_id UUID NULL REFERENCES agent_runs(id)`.
  - `attachments`: `event_id UUID NULL`, `author_kind TEXT NULL`,
    `author_id UUID NULL`, `source_path TEXT NULL`. Nullable now; WP6 makes
    them `NOT NULL` after backfill.
  - `agent_runs.status` check gains `'cancelled'`.
  - Index: `threads (parent_thread_id)`, `thread_events (chat_id, kind)
    WHERE kind = 'child_result'`.
- Types: `AgentThreadKind` gains `delegated`; `AgentRunStatus` gains
  `cancelled`; the thread-event union gains `child_result`.
- Acceptance: migration applies on an empty database and on a copy of the dev
  database; `npm test --workspace apps/server` passes.

### WP2 — Store and delivery (after WP1)

- Store (`apps/server/src/agents/store.ts`, `platform/store/thread.ts`):
  - `createChildThread(parentThreadId, agentId, userId, title)` sets
    `parent_thread_id` and `depth = parent.depth + 1`.
  - `childCount(threadId)` counts per node (decision 17).
  - `subtree(threadId)` — recursive CTE over `parent_thread_id`.
  - `closeSubtree(threadId)`, `cancelSubtree(threadId)`.
  - `unconsumedChildResults(chatId)`,
    `consumeChildResults(chatId, runId)` in one transaction.
- Delivery:
  - On a child run reaching a terminal status, write one `child_result` event
    in the parent thread, then place or merge one steer input (decision 7).
  - Merge point: the pending inbox item's `content`, through the doc draft.
    **Spike this first** (see WP0). Fallback: a one-line pointer plus a read
    tool.
  - Drain at the boundary: the run takes every unconsumed `child_result` in one
    transaction and marks it with its own run id.
  - A user cancel delivers `status: cancelled`, `reason: user` (decision 10).
- Acceptance: a test that runs two children to completion while the parent is
  busy and asserts exactly one parent turn with both results, one message.

### WP3 — Tools (after WP2)

- Replace `apps/server/src/agents/delegation.ts` with the tool module:
  - `spawn(agent, task)` — create the child thread, post the first turn, return
    `{thread_id, run_id}`. No wait, no timeout, no artifact copy.
  - `send(thread_id, text)`.
  - `read(thread_id)` — bounded excerpt, same limits as `conversation_read`.
  - `list()` — children with status, depth, elapsed.
  - `cancel(thread_id)`, `close(thread_id)`.
- Allowlist: one `subagents` entry granting the six (decision 19).
- Prompt: `<spawned_by>` block with the reply rule (decision 20).
- Remove `delegate` and `release_artifacts` from the catalog and from every
  stored allowlist (WP6 handles stored rows).
- Acceptance: tool tests cover depth 3, 16 children per node, cancel cascade,
  close cascade, and a send to a closed thread being rejected.

### WP4 — Files (after WP1, parallel with WP2)

- `send_file(path, as?)`: read, hash, upload to bucket `guild` under
  `attachments/<org>/<id>/<filename>`, insert an `attachments` row with
  `author_kind = 'agent'`, `author_id`, `source_path`, bound to the running
  turn. Publish onto the assistant event at turn end (decision 13).
- Materialization: before a turn starts, write the message's attachments into
  the sandbox at `/tmp/attachments/<runId>/`; wipe at the next turn start
  (decision 14). Applies to user uploads and child deliveries alike.
- Delete `transferArtifacts`, `releaseArtifacts`, the staging root, the 16 MiB
  branch, and `outboxFiles`.
- Acceptance: a user upload and a child delivery both appear at the same path
  for the consuming turn; a second turn does not see the first turn's files;
  no file is written into `/workspace`.

### WP5 — UI (after WP3)

- One compact row per spawn in the parent transcript: agent name, status dot,
  elapsed from `started_at`, chevron to the child thread (decision 16).
- The child thread needs a real URL. All navigation is URL state
  (`apps/desktop/src/views/WebChat.tsx`, `ChatRoute`/`pushRoute`); model the
  child route on `skills-route.ts`.
- The row offers cancel and close; the child thread page offers the same.
- Acceptance: `cd apps/desktop && npm test`; deep link to a child thread
  survives reload and back/forward.

### WP6 — Migration and removal (last)

- Relabel existing delegation threads from `routine_run` to `delegated`; they
  are identified by a run with `parent_run_id` set and trigger `delegation`.
- Backfill `threads.parent_thread_id` and `depth` from `agent_runs`.
- Backfill `attachments.event_id`/`author_kind`/`author_id`, then make them
  `NOT NULL`.
- Copy `agent_delegation_artifacts` rows into `attachments`, then drop the
  table.
- Remove `delegate`/`release_artifacts` from stored agent allowlists.
- Acceptance: dev database migrated; an old delegated thread renders; its
  artifacts resolve through the attachment route.

### WP0 — Merge spike (before WP2)

Answer one question: can a delivery append to the `content` of a pending,
unplaced inbox item through the doc draft, and does the appended text survive
placement?

- `InboxState = { items: InboxItem[] }`, `InboxItem.content` is
  `UserInput`. `steerQueued` mutates `item.mode` the same way
  (`apps/server/src/harness/runtime.ts:1492`).
- Test with two submissions placed at one boundary.
- If it does not hold: switch decision 7 to the pointer-plus-read-tool fallback
  and update the spec before WP2 starts.

## Order

```
WP0 ──┐
WP1 ──┴─┬─ WP2 ── WP3 ── WP5
        └─ WP4 ─────────────┘
                    WP6 (last)
```

WP1 blocks everything. WP2 and WP4 touch disjoint files and run in parallel.
WP3 needs WP2's delivery contract. WP5 needs WP3's API. WP6 needs the schema
and the backfill inputs.

## Verification

```bash
npm test --workspace apps/server
cd apps/desktop && npm test
scripts/check-bindings.sh      # must stay clean: decision 16 adds no frame field
```

A desktop change always ships with a client release (`docs/clients.md`), and
the compose rebuild from `docs/deploy-nuances.md` §2 runs in the same task.

## Risks

- **An `always_ask` integration curation produces no approval card.**
  `m8-chat.test.ts` covered this and failed on `develop` (`26f444c8`) before
  this branch existed: the curated `slack_conversations_list` call never writes
  an `approval_request` event, while `always_allow` executes correctly. The
  failing case was removed so the suite is green; the gate itself is unfixed.
  In `approvals.ts` the ask branch ends in `if (decision === "ask") return
  undefined`, so an ask that reaches that line becomes an allow. Find out why
  `gateDecision` does not return `"ask"` for the curated read tool.

- **Inbox content mutation** (WP0). The only undocumented API in the design.
  Test it first; the fallback costs one model call per batch.
- **`attachments.event_id NOT NULL`** breaks existing rows. Backfill before the
  constraint, in that order.
- **Cross-worker cancel** needs a `remoteStop` IPC next to `remoteSubmit`
  (`apps/server/src/platform/context.ts:200`). Until it lands, `cancel` works
  only for chats the calling worker owns.
- **Old delegated threads** are `routine_run` today and hidden by
  `NOT_EXECUTION_TRANSCRIPT` (`apps/server/src/platform/store/chats.ts:76`).
  Relabelling to `delegated` keeps them hidden, which is intended.
