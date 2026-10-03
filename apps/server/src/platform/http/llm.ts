// Shared pipeline for the public LLM gateway endpoints (crates/server/src/
// http/llm_proxy.rs port): API key auth (per-shape extractor) → org route
// resolution → quota → provider stream. Each surface renders errors in its
// own wire contract (OpenAI `{"error": …}` vs Anthropic `{"type":"error",…}`)
// and records usage against the key's owner.

import { ApiError } from "./error.js";
import { forProtocol, ProviderError, type InternalMessage, type ProviderChunk, type ToolSpec } from "../provider/types.js";
import { enforceQuota, newRequestId, UsageEvent, UsageSink, usageCostUsd, errorText } from "../usage.js";
import type { GatewayStore } from "../store/gateway.js";

/** The gateway pipeline's slice of the platform context. */
export interface GatewayContext {
  masterKey(): Buffer;
  gatewayStore: GatewayStore;
  usage: UsageSink;
}

/** Credential resolved by a gateway auth extractor: a real api_keys row, or
 *  the config-minted internal key (spec decision 7 — the pi-durable harness
 *  calls /openai/v1 over loopback with it; never issued via the API). */
export interface GatewayCredential {
  /** Usage + route scope. */
  orgId: string;
  /** Usage attribution: the key's owner when user-minted, else the admin
   *  who created it; internal calls carry the harness-provided user or the
   *  synthetic internal identity. */
  userId: string;
  /** session_id on usage rows: the key's id (internal: harness-provided
   *  session or the fixed internal-key id). */
  sessionId: string;
}

/** Endpoint-neutral failure; each gateway surface renders it in its own
 *  error contract. */
export class ProxyError extends Error {
  constructor(public apiError: ApiError) {
    super(apiError.message);
  }

  /** The OpenAI error `type` string for the failure class. */
  get openaiType(): string {
    return this.apiError.code === "quota_exceeded" ? "quota_exceeded" : "invalid_request_error";
  }

  /** The Anthropic error `type` string for the failure class. */
  get anthropicType(): string {
    switch (this.apiError.code) {
      case "not_found":
        return "not_found_error";
      case "unauthorized":
        return "authentication_error";
      case "quota_exceeded":
        return "rate_limit_error";
      default:
        return "api_error";
    }
  }
}

export interface RoutedCall {
  stream: AsyncIterable<ProviderChunk | ProviderError>;
  model: string;
  provider: string;
  priceIn: number;
  priceOut: number;
  usage: UsageSink;
}

/** Resolves the org route for `model`, enforces the route quota, and opens
 *  the provider stream. Model scoping is the same as in-app chat: whatever
 *  the org's route table resolves. */
export async function dispatch(
  ctx: GatewayContext,
  orgId: string,
  model: string,
  system: string | null,
  messages: InternalMessage[],
  tools: ToolSpec[] | null,
  clientMaxTokens: number | null,
): Promise<RoutedCall> {
  const route = await ctx.gatewayStore.resolveRoute(orgId, model, ctx.masterKey());
  await ctx.usage.ensureOnce();
  await enforceQuota(ctx.usage, orgId, model, route);
  const provider = forProtocol(route.protocol);
  if (provider === null) {
    throw new ApiError(500, "internal", `unknown protocol ${route.protocol}`);
  }
  // The tighter limit wins when both sides set one: a client asking for
  // less than the route cap must not be billed for output it did not ask
  // for (0 = provider default). A nonpositive cap (legacy row, hand-edited
  // DB) is not a cap: through min() it would erase a positive client
  // limit. The same holds for a nonpositive client limit.
  const routeCap = route.maxOutputTokens !== null && route.maxOutputTokens > 0 ? route.maxOutputTokens : null;
  const clientCap = clientMaxTokens !== null && clientMaxTokens > 0 ? clientMaxTokens : null;
  let maxTokens: number;
  if (routeCap !== null && clientCap !== null) {
    maxTokens = Math.min(routeCap, clientCap);
  } else {
    maxTokens = routeCap ?? clientCap ?? 0;
  }
  const stream = await provider.chatStream({
    model,
    system,
    messages,
    apiKey: route.apiKey,
    baseUrl: route.baseUrl,
    tools,
    maxTokens,
  }).catch((error: unknown) => {
    throw new ProxyError(
      new ApiError(502, "provider_error", error instanceof ProviderError ? error.message : errorText(error)),
    );
  });
  return {
    stream,
    model,
    provider: route.provider,
    priceIn: route.priceIn,
    priceOut: route.priceOut,
    usage: ctx.usage,
  };
}

/** A completed gateway call's usage event (key owner attribution). */
export function usageEvent(
  credential: GatewayCredential,
  model: string,
  provider: string,
  priceIn: number,
  priceOut: number,
  tokensIn: number,
  tokensOut: number,
  requestId: string,
): UsageEvent {
  return {
    ts: new Date(),
    org_id: credential.orgId,
    user_id: credential.userId,
    team_id: null,
    session_id: credential.sessionId,
    model,
    provider,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost_usd: usageCostUsd(tokensIn, tokensOut, priceIn, priceOut),
    request_id: requestId,
  };
}

/** Usage counters a gateway stream loop updates per frame; the guard reads
 *  them at drop. */
export class StreamUsageCounters {
  // Mutation happens only through observe()/set() from the stream loops;
  // the recording helpers read the totals at the guard's exit paths.
  tokensIn = 0;
  tokensOut = 0;
  /** Provider frames seen — a stream that produced anything counts as a
   *  billable request even if the usage totals never arrived (abort). */
  frames = 0;

  /** Marks a provider frame as observed (every chunk, usage or not). */
  observe(): void {
    this.frames += 1;
  }

  /** Provider usage frames carry absolute totals. */
  set(tokensIn?: number, tokensOut?: number): void {
    if (tokensIn !== undefined) this.tokensIn = tokensIn;
    if (tokensOut !== undefined) this.tokensOut = tokensOut;
  }
}

/** What a drained provider stream produced: the model-facing content, the
 *  terminal finish reason (canonical OpenAI vocabulary, when the provider
 *  reported one), and usage totals. */
export interface Accumulated {
  text: string;
  reasoning: string;
  calls: NonNullable<InternalMessage["tool_calls"]>;
  finishReason: string | null;
  tokensIn: number;
  tokensOut: number;
}

/** Drains the provider stream, folding tool-call fragments into complete
 *  calls (the streaming endpoints emit fragments themselves, the
 *  non-streaming ones use this). */
export async function accumulate(
  stream: AsyncIterable<ProviderChunk | ProviderError>,
  counters: StreamUsageCounters,
): Promise<Accumulated> {
  let text = "";
  let reasoning = "";
  const calls: NonNullable<InternalMessage["tool_calls"]> = [];
  let finishReason: string | null = null;
  let tokensIn = 0;
  let tokensOut = 0;
  for await (const item of stream) {
    if (item instanceof ProviderError) throw item;
    counters.observe();
    switch (item.kind) {
      case "text":
        text += item.textDelta;
        if (item.tokensIn !== undefined) tokensIn = item.tokensIn;
        if (item.tokensOut !== undefined) tokensOut = item.tokensOut;
        counters.set(item.tokensIn, item.tokensOut);
        break;
      // Reasoning is preserved end to end (protocol contract: it is never
      // dropped from context): non-streaming clients get it in the response
      // message so they can replay it.
      case "thinking":
        reasoning += item.textDelta;
        break;
      case "toolCallDelta":
        break;
      case "toolCallDone":
        calls.push(item.call);
        break;
      case "finished":
        finishReason = item.reason;
        break;
    }
  }
  return { text, reasoning, calls, finishReason, tokensIn, tokensOut };
}

/** Renders the provider's canonical finish reason (or the shape-derived
 *  fallback) — `length`/`content_filter` terminations must reach the client
 *  as what they are, not as a normal stop. */
export function gatewayFinishReason(reported: string | null, hasCalls: boolean): string {
  switch (reported) {
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
      return "length";
    case "content_filter":
      return "content_filter";
    case "stop":
      return "stop";
    // Unknown reason or none reported: fall back to the shape-derived
    // verdict (today's behavior).
    default:
      return hasCalls ? "tool_calls" : "stop";
  }
}

/** Usage recording for a completed (non-streaming) call: synchronous before
 *  the response returns — quota checks and tests read right after. */
export async function recordUsageSync(
  usage: UsageSink,
  credential: GatewayCredential,
  model: string,
  provider: string,
  priceIn: number,
  priceOut: number,
  counters: StreamUsageCounters,
): Promise<void> {
  await usage.record(
    usageEvent(
      credential,
      model,
      provider,
      priceIn,
      priceOut,
      counters.tokensIn,
      counters.tokensOut,
      newRequestId(),
    ),
  );
}

/** Usage recording for a stream that exited without its final frame
 *  (provider error after frames, or a client disconnect): a request that
 *  produced anything is billed; a stream that produced nothing records
 *  nothing. Fire-and-forget like the Rust drop path. */
export function recordUsageDropped(
  usage: UsageSink,
  credential: GatewayCredential,
  model: string,
  provider: string,
  priceIn: number,
  priceOut: number,
  counters: StreamUsageCounters,
): void {
  if (counters.frames === 0) return;
  void usage.record(
    usageEvent(
      credential,
      model,
      provider,
      priceIn,
      priceOut,
      counters.tokensIn,
      counters.tokensOut,
      newRequestId(),
    ),
  );
}
