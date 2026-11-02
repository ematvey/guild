// The run rows the run lifecycle settles: a chat's open run, the guarded
// terminal update, a child chat's cancellation, the row mirrored to
// ClickHouse, and the send_message signal that a run reached the user.

import type { PlatformPool } from "../../platform/db.js";
import { utcText } from "../../platform/time.js";

export interface OpenChatRun {
  id: string;
  agent_id: string;
  thread_id: string;
  chat_id: string;
  started_at: string;
}

/** The chat's oldest queued or running run, or null. */
export async function openRunForChat(pool: PlatformPool, chatId: string): Promise<OpenChatRun | null> {
  const res = await pool.query<OpenChatRun>(
    `SELECT r.id, r.agent_id, r.thread_id, t.chat_id,
            ${utcText("COALESCE(r.started_at, r.created_at)")} AS started_at
     FROM agent_runs r JOIN agent_threads t ON t.id = r.thread_id
     WHERE t.chat_id = $1 AND r.status IN ('queued', 'running')
     ORDER BY r.created_at ASC, r.id ASC
     LIMIT 1`,
    [chatId],
  );
  return res.rows[0] ?? null;
}

export interface RunOutcome {
  status: string;
  summary: string | null;
  tokens: number;
  error_code: string | null;
  error_message: string | null;
}

/** Writes the run's terminal state; false when it was already terminal. */
export async function settleRun(pool: PlatformPool, runId: string, outcome: RunOutcome): Promise<boolean> {
  const updated = await pool.query<{ id: string }>(
    `UPDATE agent_runs
     SET status = $2, summary = $3, tokens = $4, finished_at = now(),
         error_code = $5, error_message = $6
     WHERE id = $1 AND status IN ('queued', 'running')
     RETURNING id`,
    [runId, outcome.status, outcome.summary, outcome.tokens, outcome.error_code, outcome.error_message],
  );
  return updated.rowCount !== 0;
}

/** Cancels the thread's queued and running runs; returns each with its
 *  start. */
export async function cancelOpenRuns(
  pool: PlatformPool,
  threadId: string,
): Promise<{ id: string; started_at: string }[]> {
  const runs = await pool.query<{ id: string; started_at: string }>(
    `UPDATE agent_runs
     SET status = 'cancelled', finished_at = now()
     WHERE thread_id = $1 AND status IN ('queued', 'running')
     RETURNING id,
       ${utcText("COALESCE(started_at, created_at)")} AS started_at`,
    [threadId],
  );
  return runs.rows;
}

/** One run with its agent's org and name and its thread's chat, as the
 *  trace mirror records it. */
export async function runTraceRow(pool: PlatformPool, runId: string): Promise<Record<string, unknown> | null> {
  const res = await pool.query<Record<string, unknown>>(
    `SELECT r.id, r.agent_id, r.user_id, r.thread_id, r.routine_id, r.parent_run_id,
            r.trigger, r.status, r.summary, r.error_message, r.tokens,
            r.started_at, r.finished_at, r.created_at,
            a.org_id, a.name AS agent_name, t.chat_id
     FROM agent_runs r
     JOIN agents a ON a.id = r.agent_id
     LEFT JOIN agent_threads t ON t.id = r.thread_id
     WHERE r.id = $1`,
    [runId],
  );
  return res.rows[0] ?? null;
}

/** Whether the agent opened a thread other than `threadId` since `since`. */
export async function openedThreadSince(
  pool: PlatformPool,
  agentId: string,
  threadId: string,
  since: string,
): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM agent_threads
     WHERE agent_id = $1 AND id <> $2 AND created_at >= $3::timestamptz
     LIMIT 1`,
    [agentId, threadId, since],
  );
  return (res.rowCount ?? 0) > 0;
}
