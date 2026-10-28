// The chat's thread subtree: the read used by the REST route and the member
// socket, plus the NOTIFY that tells every ancestor chat's viewers to
// re-push it.

import type { PlatformPool } from "../platform/db.js";
import type { WsServerMsg } from "../hub/protocol.js";
import type { SubagentNode } from "@guild/wire/rest";

/** One node of a chat's thread subtree, with its latest run status. */
export type { SubagentNode };

/** Every thread under the chat's own thread, at any depth. */
export async function chatSubagentNodes(
  pool: PlatformPool,
  chatId: string,
): Promise<SubagentNode[]> {
  const res = await pool.query<{
    thread_id: string;
    chat_id: string;
    parent_thread_id: string | null;
    agent_name: string;
    title: string;
    depth: number;
    status: string | null;
  }>(
    `WITH RECURSIVE subtree AS (
       SELECT t.id, t.chat_id, t.parent_thread_id, t.agent_id, t.title, t.depth
       FROM agent_threads t WHERE t.chat_id = $1
       UNION ALL
       SELECT c.id, c.chat_id, c.parent_thread_id, c.agent_id, c.title, c.depth
       FROM agent_threads c JOIN subtree p ON c.parent_thread_id = p.id
     )
     SELECT s.id AS thread_id, s.chat_id, s.parent_thread_id, a.name AS agent_name,
            s.title, s.depth,
            (SELECT r.status FROM agent_runs r WHERE r.thread_id = s.id
             ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS status
     FROM subtree s JOIN agents a ON a.id = s.agent_id
     ORDER BY s.depth, s.id`,
    [chatId],
  );
  return res.rows.map((row) => ({
    thread_id: row.thread_id,
    chat_id: row.chat_id,
    parent_thread_id: row.parent_thread_id,
    agent_name: row.agent_name,
    title: row.title,
    depth: Number(row.depth),
    status: row.status,
  }));
}

export function subagentTreeMsg(chatId: string, nodes: SubagentNode[]): WsServerMsg {
  return { type: "subagent_tree", chat_id: chatId, nodes };
}

/** Tells every ancestor chat (and the thread's own chat) that its subtree
 *  changed. A node's creation, run-status change or close moves the tree of
 *  every thread above it, and each of those chats may be open somewhere. */
export async function notifySubagentTree(pool: PlatformPool, threadId: string): Promise<void> {
  await pool.query(
    `WITH RECURSIVE up AS (
       SELECT id, parent_thread_id, chat_id FROM agent_threads WHERE id = $1
       UNION ALL
       SELECT t.id, t.parent_thread_id, t.chat_id
       FROM agent_threads t JOIN up ON t.id = up.parent_thread_id
     )
     SELECT pg_notify('guild_subagent_tree', chat_id::text) FROM up`,
    [threadId],
  );
}
