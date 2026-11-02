// The chat's thread subtree and its header facts: the reads used by the REST
// routes and the member socket (agents/store/tree.ts), the frames that carry
// them, and the NOTIFY that tells every ancestor chat's viewers to re-push.

import type { ChatTree, SubagentNode } from "@guild/wire/rest";
import type { WsServerMsg } from "../hub/protocol.js";

export { chatSubagentNodes, chatTreeFacts, notifySubagentTree } from "./store/tree.js";

/** One node of a chat's thread subtree, with its latest run status. */
export type { SubagentNode };

export function subagentTreeMsg(chatId: string, nodes: SubagentNode[]): WsServerMsg {
  return { type: "subagent_tree", chat_id: chatId, nodes };
}

export function chatTreeMsg(tree: ChatTree): WsServerMsg {
  return { type: "chat_tree", chat_id: tree.chat_id, tree };
}
