// A chat's context usage: the tokens of its last completed model request
// since the last compaction and the model that request ran on. The member
// socket carries it as the `context_usage` frame (in the chat's sync bracket
// and whenever it moves); GET /threads/:id/context answers the same read.

import type { EntryRecord } from "@earendil-works/pi-durable";
import { calculateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { WsServerMsg } from "../hub/protocol.js";
import type { GatewayStore } from "../platform/store/gateway.js";
import { assistantEntriesSinceHead, type DurableQueryable } from "../storage/postgres/queries.js";

/** The context window of a model whose route sets none. */
export const DEFAULT_CONTEXT_WINDOW = 128_000;

export interface ContextUsageReads {
  /** The durable entries the measurement is read from. */
  readonly pool: DurableQueryable;
  readonly gatewayStore: Pick<GatewayStore, "aliasOf">;
}

/** Latest measured context, including the answer and cached input. A head
 *  change (reset/compaction) invalidates measurements of the old prefix.
 *  Reads immutable entries directly, so it works without starting a
 *  worker. Records are JSON text and may carry characters JSONB rejects, so
 *  the parse happens here. */
export async function contextUsage(
  db: DurableQueryable,
  orgId: string,
  chatId: string,
): Promise<{ tokens: number; model: string } | null> {
  const records = await assistantEntriesSinceHead(db, orgId, chatId, 50);
  for (const record of records) {
    const entry = JSON.parse(record) as EntryRecord;
    const message = entry.model?.find((m) => m.role === "assistant");
    if (message === undefined || message.role !== "assistant") continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;
    const tokens = calculateContextTokens(message.usage);
    return Number.isFinite(tokens) && tokens > 0 ? { tokens, model: message.model } : null;
  }
  return null;
}

/** The `context_usage` frame for one chat. */
export async function contextUsageMsg(ctx: ContextUsageReads, orgId: string, chatId: string): Promise<WsServerMsg> {
  const usage = await contextUsage(ctx.pool, orgId, chatId);
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
