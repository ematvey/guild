// sandboxWorkspace: the sandbox target for a chat. A chat that belongs to an
// agent_threads row runs in the agent's shared directory
// (agents/<org>/<agentId>) and sandbox (agent:<org>:<agentId>). Every other
// chat keeps its per-conversation sandbox.

import type { PlatformPool } from "../platform/db.js";
import { agentThreadForChat } from "./store/bindings.js";
import { agentWorkspaceDir, agentWorkspaceSubpath } from "./workspace-config.js";

export { agentThreadForChat, type AgentThreadRef } from "./store/bindings.js";
export { agentWorkspaceSubpath } from "./workspace-config.js";

export interface ConversationWorkspace {
  key: string;
  subpath: string;
  hostDir: string;
  chatId: string | null;
  agentId: string | null;
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
