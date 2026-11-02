// The delegation tree over agent threads (parent_thread_id): a node's
// children with their latest run, the subtree walk, and the subtree's
// in-flight runs, cancel and close.

import type { PlatformPool } from "../../platform/db.js";
import { utcText } from "../../platform/time.js";
import type { AgentRunStatus, AgentThread } from "../types.js";
import { THREAD_COLUMNS, toThread } from "./rows.js";

export interface ChildThreadSummary {
  thread: AgentThread;
  agent_name: string;
  run_id: string | null;
  status: AgentRunStatus | null;
  started_at: string | null;
  finished_at: string | null;
}

/** The node and its descendants' ids, as a recursive CTE named `tree`. */
const SUBTREE_IDS = `WITH RECURSIVE tree AS (
   SELECT id FROM agent_threads WHERE id = $1
   UNION ALL
   SELECT child.id FROM agent_threads child JOIN tree ON child.parent_thread_id = tree.id
 )`;

export class AgentTreeStore {
  constructor(private readonly pool: PlatformPool) {}

  /** Child threads of one node: the count bounds the tree shape, so it is
   *  per thread, not per run. Closed children still count. */
  async childCount(parentThreadId: string): Promise<number> {
    const res = await this.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM agent_threads WHERE parent_thread_id = $1",
      [parentThreadId],
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  /** Direct children of one node with the latest run's status and times. */
  async childThreadSummaries(parentThreadId: string): Promise<ChildThreadSummary[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${THREAD_COLUMNS}, a.name AS agent_name,
              r.id AS run_id, r.status AS run_status,
              ${utcText("COALESCE(r.started_at, r.created_at)")} AS run_started_at,
              ${utcText("r.finished_at")} AS run_finished_at
       FROM agent_threads t
       JOIN agents a ON a.id = t.agent_id
       LEFT JOIN LATERAL (
         SELECT id, status, started_at, created_at, finished_at
         FROM agent_runs WHERE thread_id = t.id
         ORDER BY created_at DESC, id DESC LIMIT 1
       ) r ON true
       WHERE t.parent_thread_id = $1
       ORDER BY t.created_at ASC, t.id ASC`,
      [parentThreadId],
    );
    return res.rows.map((row) => ({
      thread: toThread(row),
      agent_name: row.agent_name as string,
      run_id: (row.run_id as string | null) ?? null,
      status: (row.run_status as AgentRunStatus | null) ?? null,
      started_at: (row.run_started_at as string | null) ?? null,
      finished_at: (row.run_finished_at as string | null) ?? null,
    }));
  }

  /** Queued or running runs in one node's subtree, with their chat ids. */
  async activeRunsInSubtree(threadId: string): Promise<{ run_id: string; thread_id: string; chat_id: string }[]> {
    const res = await this.pool.query<{ run_id: string; thread_id: string; chat_id: string }>(
      `${SUBTREE_IDS}
       SELECT r.id AS run_id, r.thread_id, t.chat_id
       FROM agent_runs r JOIN agent_threads t ON t.id = r.thread_id
       WHERE r.thread_id IN (SELECT id FROM tree) AND r.status IN ('queued', 'running')
       ORDER BY r.created_at ASC, r.id ASC`,
      [threadId],
    );
    return res.rows;
  }

  /** The node and every descendant, root first. */
  async subtree(threadId: string): Promise<AgentThread[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      `WITH RECURSIVE tree AS (
         SELECT t.*, 0 AS distance FROM agent_threads t WHERE t.id = $1
         UNION ALL
         SELECT child.*, tree.distance + 1
         FROM agent_threads child JOIN tree ON child.parent_thread_id = tree.id
         WHERE tree.distance < 64
       )
       SELECT ${THREAD_COLUMNS} FROM tree t ORDER BY t.distance ASC, t.created_at ASC`,
      [threadId],
    );
    return res.rows.map(toThread);
  }

  /** Cancels the in-flight runs of the node and every descendant. The nodes
   *  stay addressable; only the runs stop. */
  async cancelSubtree(threadId: string): Promise<number> {
    const res = await this.pool.query(
      `${SUBTREE_IDS}
       UPDATE agent_runs SET status = 'cancelled', finished_at = now()
       WHERE thread_id IN (SELECT id FROM tree) AND status IN ('queued', 'running')`,
      [threadId],
    );
    return res.rowCount ?? 0;
  }

  /** Cancels the subtree and stamps closed_at on every node. Deliveries stop
   *  because delivery checks closed_at. Rows and attachments stay. */
  async closeSubtree(threadId: string): Promise<number> {
    await this.cancelSubtree(threadId);
    const res = await this.pool.query(
      `${SUBTREE_IDS}
       UPDATE agent_threads SET closed_at = COALESCE(closed_at, now())
       WHERE id IN (SELECT id FROM tree) AND closed_at IS NULL`,
      [threadId],
    );
    return res.rowCount ?? 0;
  }
}
