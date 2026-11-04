// Stale-run reconciliation: a run row outlives its process when a deploy or
// a crash kills the worker. Nothing else closes such a row, so the subagent
// pane counts a dead child as running forever. This pass fails the run and
// settles the parent's strip.

import type { Logger } from "pino";
import type { PlatformPool } from "../platform/db.js";
import { chatsWithUndeliveredResults, failOrphanedRun, staleRuns } from "./store/stale-runs.js";
import { notifySubagentTree } from "./store/tree.js";
import type { ChildRunFinished } from "./delivery.js";

export interface ReconcileDeps {
  pool: PlatformPool;
  runtime: {
    stopChat(chatId: string): Promise<void>;
    canStopChat(chatId: string): boolean;
    /** Delivers one ended child run's result to its parent. */
    deliverChildResult(input: ChildRunFinished): Promise<void>;
    /** Re-delivers the child results a parent chat never received. */
    deliverPending(chatId: string): Promise<boolean>;
  };
  log: Logger;
}

const DEFAULT_IDLE_MS = 10 * 60 * 1000;
/** A result younger than this may still be in flight; the sweep leaves it
 *  alone so a normal delivery is never raced. */
const DEFAULT_UNDELIVERED_MS = 2 * 60 * 1000;

/** Fails runs whose chat has shown no event for `idleMs` and holds no
 *  durable work, settles the parent's strip for a delegated child, and
 *  re-delivers a result whose first delivery never reached a turn. A quiet
 *  chat with a non-terminal task or a queued submission is alive — a turn
 *  waiting on an approval or a long tool call — or is resumed by startup
 *  recovery, so it is never failed here. */
export async function failStaleRuns(
  deps: ReconcileDeps,
  options?: { idleMs?: number; undeliveredMs?: number },
): Promise<number> {
  const idleMs = options?.idleMs ?? DEFAULT_IDLE_MS;
  const undeliveredMs = options?.undeliveredMs ?? DEFAULT_UNDELIVERED_MS;
  const stale = await staleRuns(deps.pool, idleMs);

  let failed = 0;
  for (const run of stale) {
    if (!(await failOrphanedRun(deps.pool, run.id))) continue;
    failed += 1;
    await notifySubagentTree(deps.pool, run.thread_id);

    // An orphaned child still owes its parent a result.
    if (run.parent_thread_id !== null && run.closed_at === null) {
      await deps.runtime
        .deliverChildResult({
          child_thread_id: run.thread_id,
          run_id: run.id,
          status: "failed",
          reason: "orphaned",
          final_text: "",
        })
        .catch((error: unknown) => {
          deps.log.warn({ err: error, runId: run.id }, "stale run child result delivery failed");
        });
    }

    if (deps.runtime.canStopChat(run.chat_id)) {
      await deps.runtime.stopChat(run.chat_id).catch((error: unknown) => {
        deps.log.warn({ err: error, chatId: run.chat_id }, "stale run stop failed");
      });
    }

    deps.log.info(
      { runId: run.id, threadId: run.thread_id, idleSeconds: Number(run.idle_seconds) },
      "stale run failed",
    );
  }

  await deliverUndeliveredResults(deps, undeliveredMs);
  return failed;
}

/** A delivery that never reached a turn leaves its batch unconsumed: the
 *  consume-then-steer path releases the batch when the steer fails, and the
 *  parent chat has no run to take it. This pass gives such a batch the turn
 *  it never got. */
async function deliverUndeliveredResults(deps: ReconcileDeps, undeliveredMs: number): Promise<void> {
  const chats = await chatsWithUndeliveredResults(deps.pool, undeliveredMs);
  for (const chatId of chats) {
    try {
      const delivered = await deps.runtime.deliverPending(chatId);
      if (delivered) deps.log.info({ chatId }, "undelivered child result redelivered");
    } catch (error) {
      deps.log.warn({ err: error, chatId }, "undelivered child result redelivery failed");
    }
  }
}
