// The member socket's state-sync capture: one chat's durable history and
// in-flight buffers as the authoritative ThreadState frame, plus the chat's
// thread subtree, header facts and context usage, so a (re)connect renders
// the running tree, the child thread header and the context meter without an
// HTTP fetch. The socket's sync bracket (platform/http/ws.ts) runs the read
// gate before calling either seam.

import type { PlatformPool } from "../platform/db.js";
import type { UserRow } from "../platform/store/identity.js";
import type { WsServerMsg } from "../hub/protocol.js";
import { captureThreadState, threadStateMsg, type ThreadStateReads } from "./thread-state.js";
import { chatSubagentNodes, chatTreeFacts, chatTreeMsg, subagentTreeMsg } from "../agents/tree.js";
import { contextUsageMsg, type ContextUsageReads } from "./context-usage.js";

/** The reads the two sync seams take; `pool` serves the agent-tree reads. */
export interface SyncReads extends ThreadStateReads, ContextUsageReads {
  readonly pool: PlatformPool;
}

export interface SyncSeams {
  /** SyncBegin → … → ThreadState: the chat's authoritative view. */
  sync(args: { chatId: string; user: UserRow }): Promise<WsServerMsg>;
  /** SubagentTree → ChatTree → ContextUsage, sent before the view. */
  subagentTree(args: { chatId: string; user: UserRow }): Promise<WsServerMsg[]>;
}

/** The sync seams over one set of reads. */
export function syncSeams(ctx: SyncReads): SyncSeams {
  return {
    sync: async ({ chatId, user }) =>
      threadStateMsg(await captureThreadState(ctx, ctx.pool, user.org_id, chatId)),
    subagentTree: async ({ chatId, user }) => {
      const [nodes, tree, usage] = await Promise.all([
        chatSubagentNodes(ctx.pool, chatId),
        chatTreeFacts(ctx.pool, chatId, user.id),
        contextUsageMsg(ctx, user.org_id, chatId),
      ]);
      const frames = [subagentTreeMsg(chatId, nodes)];
      if (tree !== null) frames.push(chatTreeMsg(tree));
      frames.push(usage);
      return frames;
    },
  };
}
