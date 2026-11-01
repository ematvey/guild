// A chat's context usage: the tokens of its last completed model request
// since the last compaction and the model that request ran on. The member
// socket carries it as the `context_usage` frame (in the chat's sync bracket
// and whenever it moves); GET /threads/:id/context answers the same read.

import type { WsServerMsg } from "../hub/protocol.js";
import type { ThreadStore } from "../platform/store/thread.js";
import type { GatewayStore } from "../platform/store/gateway.js";

/** The context window of a model whose route sets none. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export interface ContextUsageReads {
  readonly threads: Pick<ThreadStore, "contextUsage">;
  readonly gatewayStore: Pick<GatewayStore, "aliasOf">;
}

/** The `context_usage` frame for one chat. */
export async function contextUsageMsg(ctx: ContextUsageReads, orgId: string, chatId: string): Promise<WsServerMsg> {
  const usage = await ctx.threads.contextUsage(orgId, chatId);
  const usageModel = usage?.model ?? null;
  const alias = usageModel === null ? null : await ctx.gatewayStore.aliasOf(orgId, usageModel);
  return {
    type: "context_usage",
    chat_id: chatId,
    tokens: usage?.tokens ?? null,
    usage_model: usageModel,
    usage_model_alias: alias,
  };
}
