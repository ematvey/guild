// Stale-run reconciliation: a run row outlives its process when a deploy or
// a crash kills the worker. Nothing else closes such a row, so the subagent
// pane counts a dead child as running forever. This pass fails the run and
// settles the parent's strip.

import type { Logger } from "pino";
import type { PlatformPool } from "../platform/db.js";
import type { ThreadStore } from "../platform/store/thread.js";
import { pgTimestampToRfc3339 } from "../platform/time.js";
import { notifySubagentTree } from "./tree.js";

export interface ReconcileDeps {
  pool: PlatformPool;
  threads: ThreadStore;
  runtime: {
    stopChat(chatId: string): Promise<void>;
    canStopChat(chatId: string): boolean;
    /** Places a parent chat's unconsumed child results as one steer turn. */
    deliverPending(chatId: string): Promise<boolean>;
  };
  log: Logger;
}

const DEFAULT_IDLE_MS = 10 * 60 * 1000;
/** A result younger than this may still be in flight; the sweep leaves it
 *  alone so a normal delivery is never raced. */
const DEFAULT_UNDELIVERED_MS = 2 * 60 * 1000;

interface StaleRunRow {
  id: string;
  thread_id: string;
  chat_id: string;
  parent_thread_id: string | null;
  parent_chat_id: string | null;
  closed_at: Date | null;
  agent_name: string;
  title: string;
  started_at: string;
  idle_seconds: string;
}

/** Fails runs whose chat has shown no event for `idleMs`, settles the
 *  parent's strip for a delegated child, and re-delivers a result whose
 *  first delivery never reached a turn. */
export async function failStaleRuns(
  deps: ReconcileDeps,
  options?: { idleMs?: number; undeliveredMs?: number },
): Promise<number> {
  const idleMs = options?.idleMs ?? DEFAULT_IDLE_MS;
  const undeliveredMs = options?.undeliveredMs ?? DEFAULT_UNDELIVERED_MS;
  const res = await deps.pool.query<StaleRunRow>(
    `SELECT r.id, r.thread_id, t.chat_id, t.parent_thread_id, t.closed_at,
            pt.chat_id AS parent_chat_id,
            a.name AS agent_name, t.title,
            to_char(COALESCE(r.started_at, r.created_at) AT TIME ZONE 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at,
            extract(epoch FROM (now() - COALESCE(
              (SELECT max(e.created_at) FROM thread_events e WHERE e.chat_id = t.chat_id),
              r.started_at, r.created_at)))::bigint::text AS idle_seconds
     FROM agent_runs r
     JOIN agent_threads t ON t.id = r.thread_id
     JOIN agents a ON a.id = t.agent_id
     LEFT JOIN agent_threads pt ON pt.id = t.parent_thread_id
     WHERE r.status IN ('queued', 'running')
       AND COALESCE(
         (SELECT max(e.created_at) FROM thread_events e WHERE e.chat_id = t.chat_id),
         r.started_at, r.created_at) < now() - ($1::bigint * interval '1 millisecond')
     ORDER BY r.created_at ASC, r.id ASC`,
    [idleMs],
  );

  let failed = 0;
  for (const run of res.rows) {
    const updated = await deps.pool.query(
      `UPDATE agent_runs
       SET status = 'failed', finished_at = now(),
           error_code = 'orphaned',
           error_message = 'no activity; the run''s process is gone'
       WHERE id = $1 AND status IN ('queued', 'running')`,
      [run.id],
    );
    if (updated.rowCount === 0) continue;
    failed += 1;
    await notifySubagentTree(deps.pool, run.thread_id);

    if (run.parent_thread_id !== null && run.closed_at === null && run.parent_chat_id !== null) {
      await deps.threads
        .appendChildResult(run.parent_chat_id, {
          type: "child_result",
          thread_id: run.thread_id,
          run_id: run.id,
          chat_id: run.chat_id,
          agent_name: run.agent_name,
          title: run.title,
          status: "failed",
          reason: "orphaned",
          final_text: "",
          attachments: [],
          started_at: pgTimestampToRfc3339(run.started_at),
        })
        .catch((error: unknown) => {
          deps.log.warn({ err: error, runId: run.id }, "stale run child result append failed");
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
  const res = await deps.pool.query<{ chat_id: string }>(
    `SELECT DISTINCT e.chat_id
     FROM thread_events e
     WHERE e.type = 'child_result' AND e.consumed_by_run_id IS NULL
       AND e.created_at < now() - ($1::bigint * interval '1 millisecond')
       AND NOT EXISTS (
         SELECT 1 FROM agent_runs r JOIN agent_threads t ON t.id = r.thread_id
         WHERE t.chat_id = e.chat_id AND r.status IN ('queued', 'running'))
     ORDER BY e.chat_id`,
    [undeliveredMs],
  );
  for (const row of res.rows) {
    try {
      const delivered = await deps.runtime.deliverPending(row.chat_id);
      if (delivered) deps.log.info({ chatId: row.chat_id }, "undelivered child result redelivered");
    } catch (error) {
      deps.log.warn({ err: error, chatId: row.chat_id }, "undelivered child result redelivery failed");
    }
  }
}
