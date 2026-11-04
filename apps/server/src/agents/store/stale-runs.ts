// Stale-run reads and writes: open runs whose chat has gone quiet with no
// durable work, the orphan failure, and the chats holding child results no
// turn consumed.

import { undeliveredChildRuns } from "../../storage/postgres/queries.js";
import type { PlatformPool } from "../../platform/db.js";
import { utcText } from "../../platform/time.js";
import { agentWorkSql } from "../../storage/postgres/queries.js";

export interface StaleRunRow {
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

/** Queued and running runs whose chat has shown no event for `idleMs` and
 *  holds no durable work, oldest first. */
export async function staleRuns(pool: PlatformPool, idleMs: number): Promise<StaleRunRow[]> {
  const res = await pool.query<StaleRunRow>(
    `SELECT r.id, r.thread_id, t.chat_id, t.parent_thread_id, t.closed_at,
            pt.chat_id AS parent_chat_id,
            a.name AS agent_name, t.title,
            ${utcText("COALESCE(r.started_at, r.created_at)")} AS started_at,
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
       AND NOT EXISTS (
         SELECT 1 FROM chat_conversations c WHERE c.chat_id = t.chat_id AND (${agentWorkSql}))
     ORDER BY r.created_at ASC, r.id ASC`,
    [idleMs],
  );
  return res.rows;
}

/** Fails an open run as orphaned; false when it already settled. */
export async function failOrphanedRun(pool: PlatformPool, runId: string): Promise<boolean> {
  const updated = await pool.query(
    `UPDATE agent_runs
     SET status = 'failed', finished_at = now(),
         error_code = 'orphaned',
         error_message = 'no activity; the run''s process is gone'
     WHERE id = $1 AND status IN ('queued', 'running')`,
    [runId],
  );
  return updated.rowCount !== 0;
}

/** Parent chats holding a child result older than `undeliveredMs` that
 *  never reached their conversation, with no open run to take it. */
export async function chatsWithUndeliveredResults(pool: PlatformPool, undeliveredMs: number): Promise<string[]> {
  const runs = await undeliveredChildRuns(pool, undeliveredMs, null);
  const chats = [...new Set(runs.map((run) => run.parent_chat_id))];
  if (chats.length === 0) return [];
  const busy = await pool.query<{ chat_id: string }>(
    `SELECT DISTINCT t.chat_id FROM agent_runs r JOIN agent_threads t ON t.id = r.thread_id
     WHERE t.chat_id = ANY($1::uuid[]) AND r.status IN ('queued', 'running')`,
    [chats],
  );
  const open = new Set(busy.rows.map((row) => row.chat_id));
  return chats.filter((chat) => !open.has(chat)).sort();
}
