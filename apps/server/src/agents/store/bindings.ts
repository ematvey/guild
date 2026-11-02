// A chat's binding to an agent thread as rows: the thread behind a chat
// journal row, the user thread a first turn inserts, an agent switch, and
// the context, tree and title facts a turn reads.

import type { PlatformPool } from "../../platform/db.js";
import { uuidv7 } from "../../platform/time.js";

export interface AgentThreadRef {
  thread_id: string;
  agent_id: string;
  org_id: string;
  /** The user whose private conversation this thread is. */
  user_id: string;
}

/** The agent row behind a chat journal row, or null for a plain chat. */
export async function agentThreadForChat(pool: PlatformPool, chatId: string): Promise<AgentThreadRef | null> {
  const res = await pool.query<{ thread_id: string; agent_id: string; org_id: string; user_id: string }>(
    `SELECT t.id AS thread_id, t.agent_id, a.org_id, t.user_id
     FROM agent_threads t JOIN agents a ON a.id = t.agent_id
     WHERE t.chat_id = $1`,
    [chatId],
  );
  const row = res.rows[0];
  return row === undefined
    ? null
    : {
        thread_id: row.thread_id,
        agent_id: row.agent_id,
        org_id: row.org_id,
        user_id: row.user_id,
      };
}

/** Inserts the chat's user thread; null when another one won the race. */
export async function insertUserThread(
  pool: PlatformPool,
  args: { agentId: string; userId: string; chatId: string; title: string },
): Promise<string | null> {
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, title_locked, type)
     VALUES ($1, $2, $3, $4, $5, false, 'user')
     ON CONFLICT (chat_id) DO NOTHING
     RETURNING id`,
    [uuidv7(), args.agentId, args.userId, args.chatId, args.title],
  );
  return inserted.rows[0]?.id ?? null;
}

/** Moves the chat's thread to another agent. */
export async function moveChatThread(pool: PlatformPool, chatId: string, agentId: string): Promise<void> {
  await pool.query(
    `UPDATE agent_threads SET agent_id = $2, last_activity_at = now()
     WHERE chat_id = $1`,
    [chatId, agentId],
  );
}

/** The chat thread's type and whether it is its agent's Main thread. */
export async function chatThreadKind(
  pool: PlatformPool,
  chatId: string,
): Promise<{ type: string; is_default: boolean } | null> {
  const res = await pool.query<{ type: string; is_default: boolean }>(
    "SELECT type, is_default FROM agent_threads WHERE chat_id = $1",
    [chatId],
  );
  return res.rows[0] ?? null;
}

/** The chat's thread with its parent link, or null for a plain chat. */
export async function chatThreadNode(
  pool: PlatformPool,
  chatId: string,
): Promise<{ id: string; parent_thread_id: string | null } | null> {
  const res = await pool.query<{ id: string; parent_thread_id: string | null }>(
    "SELECT id, parent_thread_id FROM agent_threads WHERE chat_id = $1",
    [chatId],
  );
  return res.rows[0] ?? null;
}

export interface ThreadContextRow {
  type: string;
  origin_thread_id: string | null;
  origin_title: string | null;
  routine_name: string | null;
}

/** The chat thread's type, origin thread and latest routine name. */
export async function threadContextRow(pool: PlatformPool, chatId: string): Promise<ThreadContextRow | null> {
  const res = await pool.query<ThreadContextRow>(
    `SELECT t.type, t.origin_thread_id,
            (SELECT o.title FROM agent_threads o WHERE o.id = t.origin_thread_id) AS origin_title,
            (SELECT r.name FROM agent_runs rn JOIN agent_routines r ON r.id = rn.routine_id
             WHERE rn.thread_id = t.id AND rn.trigger = 'routine'
             ORDER BY rn.created_at DESC LIMIT 1) AS routine_name
     FROM agent_threads t
     WHERE t.chat_id = $1`,
    [chatId],
  );
  return res.rows[0] ?? null;
}

export interface SpawnedByRow {
  thread_id: string;
  parent_thread_id: string | null;
  depth: number;
  parent_name: string | null;
}

/** The chat thread's depth, parent and the parent's agent name. */
export async function spawnedByRow(pool: PlatformPool, chatId: string): Promise<SpawnedByRow | null> {
  const res = await pool.query<SpawnedByRow>(
    `SELECT t.id AS thread_id, t.parent_thread_id, t.depth, pa.name AS parent_name
     FROM agent_threads t
     LEFT JOIN agent_threads pt ON pt.id = t.parent_thread_id
     LEFT JOIN agents pa ON pa.id = pt.agent_id
     WHERE t.chat_id = $1`,
    [chatId],
  );
  return res.rows[0] ?? null;
}

export interface TitleSourceRow {
  org_id: string;
  title: string | null;
  title_locked: boolean;
  type: string;
  is_default: boolean;
  model: string | null;
}

/** The thread's title facts with its org and its agent's model. */
export async function titleSourceRow(
  pool: PlatformPool,
  chatId: string,
  threadId: string,
): Promise<TitleSourceRow | null> {
  const res = await pool.query<TitleSourceRow>(
    `SELECT c.org_id, t.title, t.title_locked, t.type, t.is_default, a.model
     FROM agent_threads t
     JOIN chats c ON c.id = t.chat_id
     JOIN agents a ON a.id = t.agent_id
     WHERE t.id = $1 AND t.chat_id = $2`,
    [threadId, chatId],
  );
  return res.rows[0] ?? null;
}

/** A thread's title, or null when the thread is gone. */
export async function threadTitle(pool: PlatformPool, threadId: string): Promise<string | null> {
  const res = await pool.query<{ title: string }>("SELECT title FROM agent_threads WHERE id = $1", [threadId]);
  return res.rows[0]?.title ?? null;
}

/** A thread's chat id, or null when the thread is gone. */
export async function threadChatId(pool: PlatformPool, threadId: string): Promise<string | null> {
  const res = await pool.query<{ chat_id: string }>("SELECT chat_id FROM agent_threads WHERE id = $1", [threadId]);
  return res.rows[0]?.chat_id ?? null;
}
