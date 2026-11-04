// Child-run delivery reads: the child thread with its parent link, the
// parent thread a result lands in, the run's stored status, and the
// attachments a child's assistant event carries.

import type { PlatformPool } from "../../platform/db.js";
import { utcText } from "../../platform/time.js";

export interface ChildThreadRow {
  parent_thread_id: string | null;
  closed_at: Date | null;
  chat_id: string;
  agent_name: string;
  title: string;
}

/** A parent thread a delivery wakes, with its chat's org and agent model. */
export interface ParentThread {
  id: string;
  chat_id: string;
  agent_id: string;
  user_id: string;
  depth: number;
  org_id: string;
  model: string;
  parent_closed_at: Date | null;
}

const PARENT_SELECT = `SELECT t.id, t.chat_id, t.agent_id, t.user_id, t.depth,
              t.closed_at AS parent_closed_at, c.org_id, a.model
       FROM agent_threads t
       JOIN chats c ON c.id = t.chat_id
       JOIN agents a ON a.id = t.agent_id`;

export async function childThread(pool: PlatformPool, threadId: string): Promise<ChildThreadRow | null> {
  const res = await pool.query<ChildThreadRow>(
    `SELECT t.parent_thread_id, t.closed_at, t.chat_id, t.title, a.name AS agent_name
     FROM agent_threads t JOIN agents a ON a.id = t.agent_id WHERE t.id = $1`,
    [threadId],
  );
  return res.rows[0] ?? null;
}

export async function parentThreadById(pool: PlatformPool, threadId: string): Promise<ParentThread | null> {
  const res = await pool.query<ParentThread>(
    `${PARENT_SELECT}
       WHERE t.id = $1`,
    [threadId],
  );
  return res.rows[0] ?? null;
}

/** A run's stored status and start, or null. */
export async function runState(
  pool: PlatformPool,
  runId: string,
): Promise<{ status: string; started_at: string | null } | null> {
  const res = await pool.query<{ status: string; started_at: string | null }>(
    `SELECT status,
            ${utcText("started_at")} AS started_at
     FROM agent_runs WHERE id = $1`,
    [runId],
  );
  return res.rows[0] ?? null;
}

export interface EventAttachmentRow {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
}

/** The attachments bound to one event, oldest first. */
export async function eventAttachments(pool: PlatformPool, eventId: string): Promise<EventAttachmentRow[]> {
  const res = await pool.query<EventAttachmentRow>(
    `SELECT id, filename, content_type, size_bytes FROM attachments
     WHERE event_id = $1 ORDER BY created_at ASC, id ASC`,
    [eventId],
  );
  return res.rows;
}
