// The LLM gateway pipeline shared by the /openai and /anthropic surfaces:
// the resolved credential, trace context, org route resolution → quota →
// provider stream, and usage/trace recording against the key's owner. Each
// surface renders errors in its own wire contract (OpenAI `{"error": …}` vs
// Anthropic `{"type":"error",…}`).

import type { AgentGateway } from "./agentgateway.js";
import { ApiError, TextError } from "./errors.js";
import {
  forProtocol,
  ProviderError,
  type InternalMessage,
  type ProviderChunk,
  type ToolSpec,
} from "./provider/types.js";
import { enforceQuota, newRequestId, type UsageEvent, type UsageSink, usageCostUsd, errorText } from "./usage.js";
import type { TraceStore } from "./trace.js";
import type { GatewayStore } from "./store/gateway.js";
import type { MediaResolver } from "./media-ref.js";

/** Gateway request-body rejections are plain text in serde_json's wording:
 *  OpenAI/Anthropic SDK clients surface the body verbatim. */
export const JSON_REJECTION_PREFIX = "Failed to parse the request body as JSON: ";
export const DESERIALIZE_PREFIX = "Failed to deserialize the JSON body into the target type: ";

/** A required request field is absent; `rawLength` is the body's length
 *  (serde reports the end of input as the column). */
export function missingFieldError(field: string, rawLength: number): TextError {
  return new TextError(422, `${DESERIALIZE_PREFIX}missing field \`${field}\` at line 1 column ${rawLength}`);
}

/** Request body ceiling for the gateway surfaces. A chat-completions call
 *  carries the whole conversation on every step, including base64 images
 *  from tool results, so the default 1 MiB API limit rejects long turns. */
export const GATEWAY_BODY_LIMIT_BYTES = 50 * 1024 * 1024;

/** The gateway pipeline's slice of the platform context. */
export interface GatewayContext {
  masterKey(): Buffer;
  gatewayStore: GatewayStore;
  agentGateway?: AgentGateway | null;
  usage: UsageSink;
  trace: TraceStore;
  /** Image references in the conversation resolve to bytes here, once per
   *  worker (chats/media-ref.ts). */
  media: Pick<MediaResolver, "resolveMessages">;
}

/** The trace-context request headers the in-app harness sets on internal
 *  key calls: `x-guild-internal-caller` (self-reported calls — the gateway
 *  records no llm span for them), plus the run/chat/conversation/turn/cause
 *  context and an optional caller-minted request id so a judge's own span
 *  and its usage_events row join. */
export interface GatewayTraceHeaders {
  internalCaller: boolean;
  requestId: string | null;
  /** The agent run the call belongs to (set by the in-app harness). */
  runId: string | null;
  chatId: string | null;
  conversationId: number | null;
  turn: number | null;
  cause: string;
}

const headerOr = (headers: Record<string, unknown>, name: string): string | null => {
  const value = headers[name];
  return typeof value === "string" && value !== "" ? value : null;
};

const NO_TRACE_HEADERS: GatewayTraceHeaders = {
  internalCaller: false,
  requestId: null,
  runId: null,
  chatId: null,
  conversationId: null,
  turn: null,
  cause: "",
};

/** Reads the trace-context headers off a gateway request. Only the internal
 *  credential's headers count: a public key cannot suppress its own trace
 *  row, pin a request id, or file its call under another run or chat.
 *  Malformed values degrade to null — tracing must never reject a call. */
export function readTraceHeaders(headers: Record<string, unknown>, credential: GatewayCredential): GatewayTraceHeaders {
  if (!credential.internal) return NO_TRACE_HEADERS;
  const conversation = headerOr(headers, "x-guild-conversation-id");
  const turn = headerOr(headers, "x-guild-turn");
  return {
    internalCaller: headerOr(headers, "x-guild-internal-caller") !== null,
    requestId: headerOr(headers, "x-guild-request-id"),
    runId: headerOr(headers, "x-guild-run-id"),
    chatId: headerOr(headers, "x-guild-chat-id"),
    conversationId: conversation !== null && /^\d+$/.test(conversation) ? Number(conversation) : null,
    turn: turn !== null && /^-?\d+$/.test(turn) ? Number(turn) : null,
    cause: headerOr(headers, "x-guild-cause") ?? "",
  };
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
  /** The config-minted internal key: its x-guild-* trace headers are
   *  trusted. */
  internal: boolean;
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
  clientTemperature: number | null = null,
): Promise<RoutedCall> {
  const route = await ctx.gatewayStore.resolveRoute(orgId, model, ctx.agentGateway ? null : ctx.masterKey());
  await ctx.usage.ensureOnce();
  await enforceQuota(ctx.usage, orgId, model, route);
  const provider = forProtocol(route.protocol);
  if (provider === null) {
    throw ApiError.internal(`unknown protocol ${route.protocol}`);
  }
  const downstream = ctx.agentGateway?.model(orgId, model, route.protocol);
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
  // A durable entry names its images instead of carrying them; the provider
  // needs the bytes.
  const resolved = await ctx.media.resolveMessages(orgId, messages);
  const stream = await provider
    .chatStream({
      model,
      system,
      messages: resolved,
      apiKey: route.apiKey,
      baseUrl: downstream?.baseUrl ?? route.baseUrl,
      gatewayAuthorization: downstream?.authorization,
      tools,
      maxTokens,
      // A client that names its own temperature wins; otherwise the route's
      // configured default applies (null = provider default).
      temperature: clientTemperature ?? route.temperature,
    })
    .catch((error: unknown) => {
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

/** Validates a client-specified sampling temperature. Absent = null (the
 *  route's configured default then applies); out of range = 400. */
export function clientTemperature(v: unknown): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > 2) {
    throw new ApiError(400, "invalid_request_error", "temperature must be within (0, 2]");
  }
  return v;
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
  /** Provider-reported reasoning tokens (OpenAI
   *  completion_tokens_details.reasoning_tokens). */
  reasoningTokens = 0;
  /** Provider frames seen — a stream that produced anything counts as a
   *  billable request even if the usage totals never arrived (abort). */
  frames = 0;

  /** Marks a provider frame as observed (every chunk, usage or not). */
  observe(): void {
    this.frames += 1;
  }

  /** Provider usage frames carry absolute totals. */
  set(tokensIn?: number, tokensOut?: number, reasoningTokens?: number): void {
    if (tokensIn !== undefined) this.tokensIn = tokensIn;
    if (tokensOut !== undefined) this.tokensOut = tokensOut;
    if (reasoningTokens !== undefined) this.reasoningTokens = reasoningTokens;
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
  reasoningTokens: number;
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
  let reasoningTokens = 0;
  for await (const item of stream) {
    if (item instanceof ProviderError) throw item;
    counters.observe();
    switch (item.kind) {
      case "text":
        text += item.textDelta;
        if (item.tokensIn !== undefined) tokensIn = item.tokensIn;
        if (item.tokensOut !== undefined) tokensOut = item.tokensOut;
        if (item.reasoningTokens !== undefined) reasoningTokens = item.reasoningTokens;
        counters.set(item.tokensIn, item.tokensOut, item.reasoningTokens);
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
  return { text, reasoning, calls, finishReason, tokensIn, tokensOut, reasoningTokens };
}

/** The accumulated stream's visible completion size (trace completion_chars). */
export function completionChars(acc: {
  text: string;
  reasoning: string;
  calls: NonNullable<InternalMessage["tool_calls"]>;
}): number {
  return (
    acc.text.length +
    acc.reasoning.length +
    acc.calls.reduce(
      (n, c) => n + (typeof c.arguments === "string" ? c.arguments.length : JSON.stringify(c.arguments ?? null).length),
      0,
    )
  );
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

/** The LLM trace emission one gateway call carries: identity + context the
 *  caller extracted from the request headers, the shared request id (it is
 *  also the usage event's), and the outcome details the stream loop knows
 *  at settle time. */
export interface GatewayTraceEmission {
  sink: TraceStore;
  requestId: string;
  runId: string | null;
  chatId: string | null;
  conversationId: number | null;
  turn: number | null;
  cause: string;
  /** Date.now() at request entry (duration_ms). */
  startedAt: number;
  /** The request body's character length. */
  promptChars: number;
}

interface UsageRecordOptions {
  /** Caller-minted request id (the judge's x-guild-request-id); generated
   *  when absent. */
  requestId?: string;
  /** LLM trace emission (the OpenAI surface; the judge self-reports). */
  trace?: GatewayTraceEmission;
  /** Trace outcome fields the caller knows at settle time. */
  completionChars?: number;
  finishReason?: string | null;
  error?: string;
  /** The wire mode (streaming endpoints pass true). */
  stream?: boolean;
}

async function emitTrace(
  credential: GatewayCredential,
  model: string,
  provider: string,
  priceIn: number,
  priceOut: number,
  counters: StreamUsageCounters,
  requestId: string,
  opts: UsageRecordOptions,
): Promise<void> {
  const t = opts.trace;
  if (t === undefined) return;
  await t.sink.record({
    ts: new Date(),
    request_id: requestId,
    org_id: credential.orgId,
    user_id: credential.userId,
    session_id: credential.sessionId,
    run_id: t.runId,
    chat_id: t.chatId,
    conversation_id: t.conversationId,
    turn: t.turn,
    caller: "model",
    cause: t.cause,
    model,
    provider,
    tokens_in: counters.tokensIn,
    tokens_out: counters.tokensOut,
    reasoning_tokens: counters.reasoningTokens,
    cost_usd: usageCostUsd(counters.tokensIn, counters.tokensOut, priceIn, priceOut),
    duration_ms: Date.now() - t.startedAt,
    finish_reason: opts.finishReason ?? "",
    stream: opts.stream ?? false,
    error: opts.error ?? "",
    verdict: null,
    verdict_reason: "",
    prompt_chars: t.promptChars,
    completion_chars: opts.completionChars ?? 0,
  });
}

/** Usage recording for a completed (non-streaming) call: synchronous before
 *  the response returns — quota checks and tests read right after. The
 *  trace row rides the same request id. */
export async function recordUsageSync(
  usage: UsageSink,
  credential: GatewayCredential,
  model: string,
  provider: string,
  priceIn: number,
  priceOut: number,
  counters: StreamUsageCounters,
  opts: UsageRecordOptions = {},
): Promise<void> {
  const requestId = opts.requestId ?? opts.trace?.requestId ?? newRequestId();
  const event = usageEvent(
    credential,
    model,
    provider,
    priceIn,
    priceOut,
    counters.tokensIn,
    counters.tokensOut,
    requestId,
  );
  await usage.record(event);
  await emitTrace(credential, model, provider, priceIn, priceOut, counters, requestId, {
    ...opts,
    finishReason: opts.finishReason ?? null,
  });
}

/** Usage recording for a stream that exited without its final frame
 *  (provider error after frames, or a client disconnect): a request that
 *  produced anything is billed; a stream that produced nothing records
 *  nothing. Fire-and-forget. */
export function recordUsageDropped(
  usage: UsageSink,
  credential: GatewayCredential,
  model: string,
  provider: string,
  priceIn: number,
  priceOut: number,
  counters: StreamUsageCounters,
  opts: UsageRecordOptions = {},
): void {
  if (counters.frames === 0) return;
  void (async () => {
    const requestId = opts.requestId ?? opts.trace?.requestId ?? newRequestId();
    await usage.record(
      usageEvent(credential, model, provider, priceIn, priceOut, counters.tokensIn, counters.tokensOut, requestId),
    );
    await emitTrace(credential, model, provider, priceIn, priceOut, counters, requestId, {
      ...opts,
      finishReason: opts.finishReason ?? null,
    });
  })();
}
