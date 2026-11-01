// The chat's thread subtree and its header facts: the reads used by the REST
// routes and the member socket, plus the NOTIFY that tells every ancestor
// chat's viewers to re-push them.

import type { PlatformPool } from "../platform/db.js";
import type { WsServerMsg } from "../hub/protocol.js";
import type { ChatTree, SubagentNode } from "@guild/wire/rest";

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

/** The chat header's tree facts: the chat's thread node, its latest run
 *  status, its parent and origin chats, and the three independent thread
 *  facts — what it is (type), and whether the user archived or deleted it —
 *  plus whether `viewerId` owns it (only the owner writes). A chat with no
 *  thread row is a plain user chat. Null when the chat does not exist. */
export async function chatTreeFacts(pool: PlatformPool, chatId: string, viewerId: string): Promise<ChatTree | null> {
  const chat = await pool.query<{ title: string | null; archived: boolean; deleted: boolean; own: boolean }>(
    `SELECT title, archived_at IS NOT NULL AS archived, deleted_at IS NOT NULL AS deleted,
            user_id = $2 AS own
     FROM chats WHERE id = $1`,
    [chatId, viewerId],
  );
  const flags = chat.rows[0];
  if (flags === undefined) return null;
  const res = await pool.query<{
    type: ChatTree["type"];
    title: string;
    depth: number;
    agent_id: string;
    agent_name: string;
    run_status: string | null;
    parent_chat_id: string | null;
    parent_title: string | null;
    origin_chat_id: string | null;
    origin_title: string | null;
  }>(
    `SELECT t.type, t.title, t.depth, t.agent_id, a.name AS agent_name,
            (SELECT r.status FROM agent_runs r WHERE r.thread_id = t.id
             ORDER BY r.created_at DESC, r.id DESC LIMIT 1) AS run_status,
            p.chat_id AS parent_chat_id, p.title AS parent_title,
            o.chat_id AS origin_chat_id, o.title AS origin_title
     FROM agent_threads t
     JOIN agents a ON a.id = t.agent_id
     LEFT JOIN agent_threads p ON p.id = t.parent_thread_id
     LEFT JOIN agent_threads o ON o.id = t.origin_thread_id
     WHERE t.chat_id = $1`,
    [chatId],
  );
  const row = res.rows[0];
  const state = { archived: flags.archived, deleted: flags.deleted, own: flags.own };
  if (row === undefined) {
    return {
      chat_id: chatId,
      type: "user",
      title: flags.title ?? "",
      agent_id: null,
      agent_name: null,
      status: null,
      depth: 0,
      parent: null,
      origin: null,
      ...state,
    };
  }
  return {
    chat_id: chatId,
    type: row.type,
    title: row.title,
    agent_id: row.agent_id,
    agent_name: row.agent_name,
    status: row.run_status,
    depth: Number(row.depth),
    parent: row.parent_chat_id === null ? null : { chat_id: row.parent_chat_id, title: row.parent_title ?? "" },
    origin: row.origin_chat_id === null ? null : { chat_id: row.origin_chat_id, title: row.origin_title ?? "" },
    ...state,
  };
}

export function chatTreeMsg(tree: ChatTree): WsServerMsg {
  return { type: "chat_tree", chat_id: tree.chat_id, tree };
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
