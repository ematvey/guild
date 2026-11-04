// A chat's context usage: the tokens of its last completed model request
// since the last compaction, plus estimates of the entries after it (posted
// agent messages, a user turn not answered yet), and the model that request
// ran on — the same count pi-durable's compaction trigger makes. The member
// socket carries it as the `context_usage` frame (in the chat's sync bracket
// and whenever it moves); GET /threads/:id/context answers the same read.

import type { EntryRecord } from "@earendil-works/pi-durable";
import { calculateContextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { WsServerMsg } from "../hub/protocol.js";
import type { GatewayStore } from "../platform/store/gateway.js";
import {
  assistantEntriesSinceHead,
  entriesSinceHeadAfter,
  type DurableQueryable,
} from "../storage/postgres/queries.js";

/** Entries after the measured request read for the estimate. */
const TRAILING_ENTRIES = 500;

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
  let measured: { id: number; tokens: number; model: string } | null = null;
  for (const record of await assistantEntriesSinceHead(db, orgId, chatId, 50)) {
    const entry = JSON.parse(record) as EntryRecord;
    const message = entry.model?.find((m) => m.role === "assistant");
    if (message === undefined || message.role !== "assistant") continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;
    const tokens = calculateContextTokens(message.usage);
    if (Number.isFinite(tokens) && tokens > 0) measured = { id: Number(entry.id), tokens, model: message.model };
    break;
  }
  let tokens = measured?.tokens ?? 0;
  let model = measured?.model ?? null;
  for (const record of await entriesSinceHeadAfter(db, orgId, chatId, measured?.id ?? 0, TRAILING_ENTRIES)) {
    const entry = JSON.parse(record) as EntryRecord;
    for (const message of entry.model ?? []) {
      // A failed or aborted reply is not part of the next request.
      if (message.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"))
        continue;
      tokens += estimateMessageTokens(message);
      if (model === null && message.role === "assistant" && message.model !== "") model = message.model;
    }
  }
  return tokens > 0 && model !== null ? { tokens, model } : null;
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
