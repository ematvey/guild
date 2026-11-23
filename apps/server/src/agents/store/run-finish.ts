// The run rows the run lifecycle opens and settles: a chat's running runs,
// the queued rows a pi-durable run takes over, the guarded terminal update,
// a child chat's cancellation, the row mirrored to ClickHouse, and the
// send_message signal that a run reached the user.

import type { PlatformPool } from "../../platform/db.js";
import { utcText } from "../../platform/time.js";

export interface OpenChatRun {
  id: string;
  agent_id: string;
  thread_id: string;
  chat_id: string;
  started_at: string;
}

/** The chat's running runs: the rows of its current pi-durable run, oldest
 *  first. More than one when several delegated turns were placed into the
 *  same run. */
export async function runningRunsForChat(pool: PlatformPool, chatId: string): Promise<OpenChatRun[]> {
  const res = await pool.query<OpenChatRun>(
    `SELECT r.id, r.agent_id, r.thread_id, t.chat_id,
            ${utcText("COALESCE(r.started_at, r.created_at)")} AS started_at
     FROM agent_runs r JOIN agent_threads t ON t.id = r.thread_id
     WHERE t.chat_id = $1 AND r.status = 'running'
     ORDER BY r.created_at ASC, r.id ASC`,
    [chatId],
  );
  return res.rows;
}

/** The agent thread a chat's runs belong to; null for a chat with none. */
export async function runThread(
  pool: PlatformPool,
  chatId: string,
): Promise<{ id: string; agent_id: string; user_id: string | null; depth: number } | null> {
  const res = await pool.query<{ id: string; agent_id: string; user_id: string | null; depth: number }>(
    "SELECT id, agent_id, user_id, depth FROM agent_threads WHERE chat_id = $1",
    [chatId],
  );
  return res.rows[0] ?? null;
}

/** The thread's queued runs created for these requests (a delegated or
 *  routine turn's run id is its input's request id), oldest first. */
export async function queuedRunsFor(
  pool: PlatformPool,
  threadId: string,
  requestIds: readonly string[],
): Promise<string[]> {
  if (requestIds.length === 0) return [];
  const res = await pool.query<{ id: string }>(
    `SELECT id FROM agent_runs
     WHERE thread_id = $1 AND status = 'queued' AND id::text = ANY($2::text[])
     ORDER BY created_at ASC, id ASC`,
    [threadId, requestIds],
  );
  return res.rows.map((row) => row.id);
}

/** The member who submitted one of these requests, earliest first; null
 *  when none was a member's turn. */
export async function requestingMember(
  pool: PlatformPool,
  chatId: string,
  requestIds: readonly string[],
): Promise<string | null> {
  if (requestIds.length === 0) return null;
  const res = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM turn_commands WHERE chat_id = $1 AND id::text = ANY($2::text[])
     ORDER BY position ASC LIMIT 1`,
    [chatId, requestIds],
  );
  return res.rows[0]?.user_id ?? null;
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
     LEFT JOIN chats c ON c.id = t.chat_id
     WHERE r.id = $1 AND c.internal IS DISTINCT FROM true`,
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
