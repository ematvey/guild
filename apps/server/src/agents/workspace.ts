// sandboxWorkspace: the sandbox target for a chat. A chat that belongs to an
// agent_threads row runs in the agent's shared directory
// (agents/<org>/<agentId>) and sandbox (agent:<org>:<agentId>). Every other
// chat keeps its per-conversation sandbox.

import type { PlatformPool } from "../platform/db.js";
import { agentWorkspaceDir, agentWorkspaceSubpath } from "./workspace-config.js";

export { agentWorkspaceSubpath } from "./workspace-config.js";

export interface AgentThreadRef {
  thread_id: string;
  agent_id: string;
  org_id: string;
  /** The user whose private conversation this thread is. */
  user_id: string;
}

export interface ConversationWorkspace {
  key: string;
  subpath: string;
  hostDir: string;
  chatId: string | null;
  agentId: string | null;
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

/** Resolves the sandbox target for one conversation. Agent threads share the
 *  agent workspace; plain chats keep chats/<org>/<conversationId>. */
export async function resolveConversationWorkspace(
  pool: PlatformPool,
  args: {
    conversationId: number;
    orgId: string;
    chatId: string | null;
    agentWorkspaceRoot: string;
    plainHostRoot: string;
  },
): Promise<ConversationWorkspace> {
  const agent = args.chatId === null ? null : await agentThreadForChat(pool, args.chatId);
  if (agent !== null) {
    const subpath = agentWorkspaceSubpath(agent.org_id, agent.agent_id);
    return {
      key: `agent:${agent.org_id}:${agent.agent_id}`,
      subpath,
      hostDir: agentWorkspaceDir(args.agentWorkspaceRoot, agent.org_id, agent.agent_id),
      chatId: args.chatId,
      agentId: agent.agent_id,
    };
  }
  return {
    key: `chat:${args.orgId}:${args.conversationId}`,
    subpath: `chats/${args.orgId}/${args.conversationId}`,
    hostDir: `${args.plainHostRoot}/${args.conversationId}`,
    chatId: args.chatId,
    agentId: null,
  };
}
