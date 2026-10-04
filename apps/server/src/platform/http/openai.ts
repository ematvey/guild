// Public OpenAI-compatible chat completions endpoint (crates/server/src/
// http/openai.rs port): `POST /openai/v1/chat/completions` with `gk_…`
// API-key auth. No chat persistence; usage is attributed to the key's
// owner. Streaming frames are byte-compatible with the Rust server
// (serde_json BTreeMap key order, `data: …\n\n` frames, `[DONE]` end).

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError, DESERIALIZE_PREFIX, RAW_BODY, TextError } from "../errors.js";
import { requireJsonBody } from "./error.js";
import {
  accumulate,
  dispatch,
  gatewayFinishReason,
  recordUsageDropped,
  recordUsageSync,
  StreamUsageCounters,
  ProxyError,
  type GatewayContext,
  type GatewayCredential,
} from "./llm.js";
import type { GatewayCtx } from "../contexts.js";
import { rustJsonText, serializeRustJson } from "../provider/sse.js";
import { ProviderError, type InternalMessage, type ProviderChunk, type ToolSpec, type ToolCall } from "../provider/types.js";
import { sseDataFrame, sseReply } from "./sse-writer.js";
import { uuidv7 } from "../time.js";
import type { UsageSink } from "../usage.js";

/** OpenAI-style error body (this endpoint's error contract): the failure
 *  class maps to an error `type` (quota stays named, everything else is an
 *  invalid_request_error — the Rust ProxyError::openai_type mapping). */
export function openaiError(status: number, errType: string, message: string): { status: number; body: string } {
  return { status, body: rustJsonText({ error: { message, type: errType } }) };
}

/** Renders a caught error in the OpenAI wire shape. */
export function renderOpenAiError(error: unknown): { status: number; body: string } {
  if (error instanceof ProxyError) {
    return openaiError(error.apiError.status, error.openaiType, error.apiError.message);
  }
  if (error instanceof ApiError) {
    return openaiError(
      error.status,
      error.code === "quota_exceeded" ? "quota_exceeded" : "invalid_request_error",
      error.message,
    );
  }
  return openaiError(500, "invalid_request_error", "internal server error");
}

interface OpenAiToolCall {
  id: string;
  function: { name: string; arguments: unknown };
}

interface OpenAiMessage {
  role: string;
  content?: unknown;
  tool_calls?: OpenAiToolCall[] | null;
  tool_call_id?: string | null;
  /** The model's chain-of-thought on replayed assistant turns (DeepSeek
   *  convention). Replay keeps it — reasoning is never dropped from
   *  context. */
  reasoning_content?: string | null;
}

interface OpenAiChatRequest {
  model: string;
  messages: OpenAiMessage[];
  stream?: boolean;
  stream_options?: { include_usage?: boolean } | null;
  tools?: { type?: string; function: { name: string; description?: string; parameters?: unknown } }[] | null;
  max_tokens?: number;
  max_completion_tokens?: number;
}

/** One message's content after decoding the wire parts. */
interface DecodedContent {
  text: string;
  images: string[];
  audio: { data: string; format: string }[];
}

/** Decodes string-or-parts content. Image (`image_url`) and audio
 *  (`input_audio`) parts become the internal media fields on user turns;
 *  any other part type is rejected explicitly instead of silently dropped. */
function decodeContent(role: string, content: unknown): DecodedContent {
  const out: DecodedContent = { text: "", images: [], audio: [] };
  if (content === undefined || content === null) {
    return out;
  }
  if (typeof content === "string") {
    out.text = content;
    return out;
  }
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const part of content) {
      const p = part as Record<string, unknown>;
      const type = typeof p["type"] === "string" ? p["type"] : "";
      if (type === "text") {
        if (typeof p["text"] !== "string") {
          throw new ApiError(400, "bad_request", "text content part is missing its text");
        }
        texts.push(p["text"]);
      } else if (type === "image_url" && role === "user") {
        const imageUrl = p["image_url"] as Record<string, unknown> | string | undefined;
        const url =
          typeof imageUrl === "string"
            ? imageUrl
            : typeof (imageUrl as Record<string, unknown> | undefined)?.["url"] === "string"
              ? (imageUrl as Record<string, unknown>)["url"]
              : null;
        if (typeof url !== "string") {
          throw new ApiError(400, "bad_request", "image_url content part is missing its url");
        }
        out.images.push(url);
      } else if (type === "input_audio" && role === "user") {
        const inputAudio = (p["input_audio"] as Record<string, unknown> | undefined) ?? {};
        if (typeof inputAudio["data"] !== "string") {
          throw new ApiError(400, "bad_request", "input_audio content part is missing its data");
        }
        if (typeof inputAudio["format"] !== "string") {
          throw new ApiError(400, "bad_request", "input_audio content part is missing its format");
        }
        out.audio.push({ data: inputAudio["data"], format: inputAudio["format"] });
      } else {
        throw new ApiError(400, "bad_request", `unsupported content part type: ${type}`);
      }
    }
    out.text = texts.join("\n");
    return out;
  }
  throw new ApiError(400, "bad_request", "message content must be a string or an array of parts");
}

/** OpenAI request → internal (system, messages). */
export function toInternalMessages(msgs: OpenAiMessage[]): [string | null, InternalMessage[]] {
  const systemParts: string[] = [];
  const out: InternalMessage[] = [];
  for (const m of msgs) {
    const decoded = decodeContent(m.role, m.content);
    if (m.role === "system" || m.role === "developer") {
      systemParts.push(decoded.text);
    } else if (m.role === "user" || m.role === "assistant") {
      out.push({
        role: m.role,
        content: decoded.text,
        images: decoded.images,
        audio: decoded.audio,
        tool_calls:
          m.tool_calls !== undefined && m.tool_calls !== null
            ? m.tool_calls.map((c) => ({
                id: c.id,
                name: c.function.name,
                arguments: parseToolArguments(c.function.arguments),
              }))
            : null,
        tool_call_id: null,
        reasoning: m.reasoning_content || null,
      });
    } else if (m.role === "tool") {
      out.push({
        role: "tool",
        content: decoded.text,
        images: [],
        audio: [],
        tool_calls: null,
        tool_call_id: m.tool_call_id ?? "",
        reasoning: null,
      });
    } else {
      out.push({
        role: m.role,
        content: decoded.text,
        images: [],
        audio: [],
        tool_calls: null,
        tool_call_id: m.tool_call_id ?? null,
        reasoning: null,
      });
    }
  }
  return [systemParts.length === 0 ? null : systemParts.join("\n\n"), out];
}

/** OpenAI clients send tool-call `arguments` as a JSON-encoded string; the
 *  internal Message carries a parsed object (the Anthropic wire requires an
 *  object and the OpenAI replay path re-encodes). Unparseable strings stay
 *  raw — the provider replay handles non-objects. */
function parseToolArguments(v: unknown): unknown {
  if (typeof v === "string") {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  return v;
}

/** Renders the OpenAI tool_calls array; a raw (unparseable upstream)
 *  argument buffer is preserved verbatim — re-encoding it as a JSON string
 *  literal would hand the client a quoted string instead of the original
 *  bytes. */
function toOpenAiToolCalls(calls: ToolCall[]): unknown {
  return calls.map((c) => ({
    id: c.id,
    type: "function",
    function: {
      name: c.name,
      arguments: typeof c.arguments === "string" ? c.arguments : serializeRustJson(c.arguments),
    },
  }));
}

function missingField(field: string, req: FastifyRequest): TextError {
  return new TextError(
    422,
    `${DESERIALIZE_PREFIX}missing field \`${field}\` at line 1 column ${(req as never as Record<symbol, string>)[RAW_BODY]?.length ?? 0}`,
  );
}

function invalidType(value: unknown, req: FastifyRequest): TextError {
  const kind =
    value === null
      ? "null"
      : typeof value === "number"
        ? Number.isInteger(value)
          ? `integer \`${value}\``
          : `floating point \`${value}\``
        : typeof value === "boolean"
          ? `boolean \`${value}\``
          : typeof value === "string"
            ? `string "${value}"`
            : "map";
  return new TextError(
    422,
    `${DESERIALIZE_PREFIX}invalid type: ${kind}, expected u32 at line 1 column ${(req as never as Record<symbol, string>)[RAW_BODY]?.length ?? 0}`,
  );
}

export function registerOpenAiRoutes(app: FastifyInstance, gateway: GatewayCtx): void {
  app.get("/openai/v1/models", async (req, reply) => {
    try {
      const credential = await gateway.gatewayCredential(req);
      const models = await gateway.gatewayStore.listModels(credential.orgId);
      return reply.type("application/json").send(
        rustJsonText({
          object: "list",
          data: models.map((m) => ({ id: m, object: "model", owned_by: "organization_owner" })),
        }),
      );
    } catch (error) {
      const rendered = renderOpenAiError(error);
      return reply.status(rendered.status).type("application/json").send(rendered.body);
    }
  });

  app.post("/openai/v1/chat/completions", async (req, reply) => {
    let credential: GatewayCredential;
    try {
      credential = await gateway.gatewayCredential(req);
    } catch (error) {
      // Auth rejections carry the error `code` field (OpenAiAuthError).
      const apiError = error as ApiError;
      return reply.status(apiError.status).type("application/json").send(
        rustJsonText({
          error: { message: apiError.message, type: "invalid_request_error", code: apiError.code },
        }),
      );
    }
    try {
      await handleChatCompletions(gateway, credential, req, reply);
    } catch (error) {
      const rendered = renderOpenAiError(error);
      return reply.status(rendered.status).type("application/json").send(rendered.body);
    }
  });
}

async function handleChatCompletions(
  gateway: GatewayContext,
  credential: GatewayCredential,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = requireJsonBody(req) as Record<string, unknown>;
  if (body["model"] === undefined) throw missingField("model", req);
  if (body["messages"] === undefined) throw missingField("messages", req);
  if (typeof body["model"] !== "string") throw invalidType(body["model"], req);
  const req0 = body as unknown as OpenAiChatRequest;
  if (!Array.isArray(req0.messages)) throw invalidType(req0.messages, req);
  for (const m of req0.messages as OpenAiMessage[]) {
    if (m.role === undefined) throw missingField("role", req);
  }
  const limitField = req0.max_completion_tokens ?? req0.max_tokens;
  if (limitField !== undefined && (typeof limitField !== "number" || !Number.isInteger(limitField) || limitField < 0)) {
    throw invalidType(limitField, req);
  }
  if (limitField === 0) {
    throw new ApiError(400, "invalid_request_error", "output token limit must be positive");
  }
  const [system, messages] = toInternalMessages(req0.messages);
  const tools: ToolSpec[] | null =
    req0.tools !== undefined && req0.tools !== null
      ? req0.tools.map((t) => ({
          name: t.function.name,
          description: t.function.description ?? "",
          parameters: t.function.parameters ?? { type: "object", properties: {} },
        }))
      : null;
  const call = await dispatch(gateway, credential.orgId, req0.model, system, messages, tools, limitField ?? null);
  const completionId = `chatcmpl-${uuidv7()}`;
  const model = call.model;
  const providerName = call.provider;

  if (req0.stream === true) {
    streamChunks(gateway, credential, reply, call.stream, {
      includeUsage: req0.stream_options?.include_usage === true,
      model,
      providerName,
      priceIn: call.priceIn,
      priceOut: call.priceOut,
      usage: call.usage,
      completionId,
    });
    return;
  }
  const counters = new StreamUsageCounters();
  let acc;
  try {
    acc = await accumulate(call.stream, counters);
  } catch (error) {
    // An in-stream provider error after frames still records (a request was
    // served); nothing observed → nothing billed.
    recordUsageDropped(gateway.usage, credential, model, providerName, call.priceIn, call.priceOut, counters);
    throw new ApiError(502, "provider_error", error instanceof ProviderError ? error.message : String(error));
  }
  await recordUsageSync(call.usage, credential, model, providerName, call.priceIn, call.priceOut, counters);
  const finishReason = gatewayFinishReason(acc.finishReason, acc.calls.length > 0);
  const message: Record<string, unknown> = { role: "assistant", content: acc.text };
  if (acc.calls.length > 0) message["tool_calls"] = toOpenAiToolCalls(acc.calls);
  if (acc.reasoning !== "") message["reasoning_content"] = acc.reasoning;
  reply.type("application/json").send(
    rustJsonText({
      id: completionId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message, finish_reason: finishReason }],
      usage: {
        prompt_tokens: acc.tokensIn,
        completion_tokens: acc.tokensOut,
        total_tokens: acc.tokensIn + acc.tokensOut,
      },
    }),
  );
}

interface StreamMeta {
  model: string;
  providerName: string;
  priceIn: number;
  priceOut: number;
  usage: UsageSink;
  completionId: string;
  /** stream_options.include_usage (OpenAI semantics): the final usage chunk
   *  (empty choices) rides before [DONE]. Only clients that ask for it see
   *  the extra frame — the default stream stays byte-identical to the Rust
   *  gateway's. The internal agent always asks (pi-ai sends
   *  stream_options.include_usage), so usage reaches the durable thread
   *  events through the loopback gateway (decision 7). */
  includeUsage: boolean;
}

/** The provider stream → OpenAI SSE chunks. The usage guard exists before
 *  the first yield: a drop at any suspension point — including the very
 *  first frame — records the running counts. */
function streamChunks(
  gateway: GatewayContext,
  credential: GatewayCredential,
  reply: FastifyReply,
  provStream: AsyncIterable<ProviderChunk | ProviderError>,
  meta: StreamMeta,
): void {
  const counters = new StreamUsageCounters();
  const created = Math.floor(Date.now() / 1000);
  const chunk = (delta: Record<string, unknown>, finish: string | null): string =>
    rustJsonText({
      id: meta.completionId,
      object: "chat.completion.chunk",
      created,
      model: meta.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    });

  const calls: ToolCall[] = [];
  let finishReason: string | null = null;

  const frames = async function* (): AsyncIterable<string> {
    // Guard semantics (the Rust StreamUsageGuard): usage records exactly
    // once on every exit path — synchronously on normal completion (before
    // the final frame), on the dropped path otherwise (provider error after
    // frames, client disconnect). A stream that produced nothing records
    // nothing.
    let settled = false;
    try {
      yield sseDataFrame(chunk({ role: "assistant" }, null));
      for await (const item of provStream) {
        if (item instanceof ProviderError) {
          yield sseDataFrame(rustJsonText({ error: { message: item.message, type: "provider_error" } }));
          return;
        }
        // Only Ok items count as served frames: an in-stream provider error
        // before any real chunk must not bill a 0-token request.
        counters.observe();
        if (item.kind === "text") {
          if (item.textDelta !== "") yield sseDataFrame(chunk({ content: item.textDelta }, null));
          counters.set(item.tokensIn, item.tokensOut);
        } else if (item.kind === "thinking") {
          if (item.textDelta !== "") yield sseDataFrame(chunk({ reasoning_content: item.textDelta }, null));
        } else if (item.kind === "toolCallDelta") {
          // fragments are folded into the Done frame by the adapter layer
        } else if (item.kind === "toolCallDone") {
          yield sseDataFrame(
            chunk({
              tool_calls: [
                {
                  index: calls.length,
                  id: item.call.id,
                  type: "function",
                  function: {
                    name: item.call.name,
                    arguments:
                      typeof item.call.arguments === "string"
                        ? item.call.arguments
                        : serializeRustJson(item.call.arguments),
                  },
                },
              ],
            },
            null,
            ),
          );
          calls.push(item.call);
        } else {
          finishReason = item.reason;
        }
      }
      const finish = gatewayFinishReason(finishReason, calls.length > 0);
      await recordUsageSync(
        gateway.usage,
        credential,
        meta.model,
        meta.providerName,
        meta.priceIn,
        meta.priceOut,
        counters,
      );
      settled = true;
      yield sseDataFrame(chunk({}, finish));
      if (meta.includeUsage) {
        yield sseDataFrame(
          rustJsonText({
            id: meta.completionId,
            object: "chat.completion.chunk",
            created,
            model: meta.model,
            choices: [],
            usage: {
              prompt_tokens: counters.tokensIn,
              completion_tokens: counters.tokensOut,
              total_tokens: counters.tokensIn + counters.tokensOut,
            },
          }),
        );
      }
      yield sseDataFrame("[DONE]");
    } finally {
      if (!settled) {
        recordUsageDropped(
          gateway.usage,
          credential,
          meta.model,
          meta.providerName,
          meta.priceIn,
          meta.priceOut,
          counters,
        );
      }
    }
  }();

  sseReply(reply, frames);
}
