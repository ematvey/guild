// The member socket's state-sync capture: one chat's durable history and
// in-flight buffers as the
// authoritative ThreadState frame, owner/admin gated (the caller argument).
// The same bracket carries the chat's thread subtree, header facts and
// context usage, behind the same access gate, so a (re)connect renders the
// running tree, the child thread header and the context meter without an
// HTTP fetch.
// Wired onto PlatformContext.wsSync / wsSubagentTree inside the socket's sync
// bracket.

import type { PlatformContext } from "../composition.js";
import type { UserRow } from "../platform/store/identity.js";
import type { WsServerMsg } from "../hub/protocol.js";
import { captureThreadState, threadStateMsg } from "./thread-state.js";
import { chatSubagentNodes, chatTreeFacts, chatTreeMsg, subagentTreeMsg } from "../agents/tree.js";
import { contextUsageMsg } from "./context-usage.js";

/** Installs the sync seam: a `sync` client message answers SyncBegin →
 *  SubagentTree → ChatTree → ContextUsage → ThreadState → SyncDone (errors ride an Error frame inside
 *  the bracket — http/ws.ts owns the bracket). */
export function wireWsSync(ctx: PlatformContext): void {
  ctx.wsSync = async (args: { chatId: string; user: UserRow }): Promise<WsServerMsg> => {
    const capture = await captureThreadState(ctx, ctx.pool, args.user.org_id, args.chatId, args.user);
    return threadStateMsg(capture);
  };
  ctx.wsSubagentTree = async (args: { chatId: string; user: UserRow }): Promise<WsServerMsg[]> => {
    // The same owner/admin gate as the state capture: a chat the caller
    // cannot read yields no tree.
    await ctx.chats.getChat(args.user.org_id, args.chatId, args.user);
    const [nodes, tree, usage] = await Promise.all([
      chatSubagentNodes(ctx.pool, args.chatId),
      chatTreeFacts(ctx.pool, args.chatId, args.user.id),
      contextUsageMsg(ctx, args.user.org_id, args.chatId),
    ]);
    const frames = [subagentTreeMsg(args.chatId, nodes)];
    if (tree !== null) frames.push(chatTreeMsg(tree));
    frames.push(usage);
    return frames;
  };
}
