// Public Anthropic-compatible Messages endpoint (crates/server/src/http/
// anthropic.rs port): `POST /anthropic/v1/messages` with `gk_…` key auth
// (`x-api-key` or `Authorization: Bearer`). Converts the Anthropic request
// shape (top-level system, content blocks, required `max_tokens`) into the
// internal message format, resolves the org route for the model, and
// renders provider output back in Anthropic shape — both non-streaming and
// as Anthropic SSE events (`message_start` / `content_block_delta` /
// `message_stop`), byte-compatible with the Rust server.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError, DESERIALIZE_PREFIX, RAW_BODY, TextError } from "../errors.js";
import { requireJsonBody } from "./error.js";
import type { PlatformContext } from "../context.js";
import {
  accumulate,
  dispatch,
  recordUsageDropped,
  recordUsageSync,
  StreamUsageCounters,
  ProxyError,
  type GatewayContext,
  type GatewayCredential,
  type RoutedCall,
} from "./llm.js";
import { rustJsonText } from "../provider/sse.js";
import { ProviderError, type InternalMessage, type ToolSpec, type ToolCall } from "../provider/types.js";
import { sseReply } from "./sse-writer.js";
import { uuidv7 } from "../time.js";

/** Resolves the bearer (or x-api-key) token; rejections render in the
 *  Anthropic error shape (`x-api-key` or `Authorization: Bearer`). */
function anthropicCredential(ctx: PlatformContext, req: FastifyRequest): Promise<GatewayCredential> {
  return ctx.gatewayCredential(req);
}

function anthropicErrorShape(errorType: string, message: string): string {
  return rustJsonText({ type: "error", error: { type: errorType, message } });
}

/** Renders a caught error in the Anthropic wire shape (the Rust
 *  ProxyError::anthropic_type mapping). */
export function renderAnthropicError(error: unknown): { status: number; body: string } {
  if (error instanceof ProxyError) {
    return { status: error.apiError.status, body: anthropicErrorShape(error.anthropicType, error.apiError.message) };
  }
  if (error instanceof ApiError) {
    const type =
      error.code === "not_found"
        ? "not_found_error"
        : error.code === "unauthorized"
          ? "authentication_error"
          : error.code === "quota_exceeded"
            ? "rate_limit_error"
            : error.code === "invalid_request_error"
              ? "invalid_request_error"
              : "api_error";
    return { status: error.status, body: anthropicErrorShape(type, error.message) };
  }
  return { status: 500, body: anthropicErrorShape("api_error", "internal server error") };
}

interface AnthropicMessage {
  role: string;
  content: unknown; // string or content-block array
}

interface AnthropicTool {
  name: string;
  description?: string | null;
  input_schema?: unknown;
}

interface AnthropicRequest {
  model: string;
  messages: AnthropicMessage[];
  system?: unknown;
  // Anthropic requires max_tokens; the route's max_output_tokens wins when
  // set, otherwise the client value applies.
  max_tokens?: number;
  stream?: boolean;
  tools?: AnthropicTool[] | null;
}

/** Anthropic request → internal (system, messages). Top-level system,
 *  text/image/tool_result blocks in user turns (tool results keep their
 *  text and image parts), text/tool_use blocks in assistant turns. An image
 *  in a form the internal media contract cannot carry is a 400, never
 *  silently dropped. Tool results are emitted before the turn's
 *  accompanying text/image: the assistant tool_calls they answer must be
 *  followed by the results on both provider shapes, and Claude clients send
 *  `[tool_result…, text]`. */
export function toInternal(req: AnthropicRequest): [string | null, InternalMessage[]] {
  let system: string | null = null;
  if (req.system !== undefined && req.system !== null) {
    if (typeof req.system === "string") {
      system = req.system;
    } else if (Array.isArray(req.system)) {
      system = (req.system as Record<string, unknown>[])
        .map((b) => (typeof b["text"] === "string" ? b["text"] : null))
        .filter((t): t is string => t !== null)
        .join("\n");
    } else {
      system = "";
    }
  }

  const out: InternalMessage[] = [];
  for (const m of req.messages) {
    const role = m.role;
    if (typeof m.content === "string") {
      out.push({
        role,
        content: m.content,
        images: [],
        audio: [],
        tool_calls: null,
        tool_call_id: null,
        reasoning: null,
      });
      continue;
    }
    const blocks = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [];
    if (role === "assistant") {
      let text = "";
      const calls: ToolCall[] = [];
      let reasoning = "";
      for (const b of blocks) {
        switch (typeof b["type"] === "string" ? b["type"] : "") {
          case "text":
            text += typeof b["text"] === "string" ? b["text"] : "";
            break;
          case "tool_use":
            calls.push({
              id: typeof b["id"] === "string" ? b["id"] : "",
              name: typeof b["name"] === "string" ? b["name"] : "",
              arguments: b["input"] ?? null,
            });
            break;
          // The model's thinking rides the internal reasoning field and is
          // replayed upstream (openai-shape routes resend it as
          // reasoning_content). Signature-bearing deltas have no internal
          // carrier beyond the text.
          case "thinking":
            if (reasoning !== "") reasoning += "\n";
            reasoning += typeof b["thinking"] === "string" ? b["thinking"] : "";
            break;
          case "redacted_thinking":
            break;
          default:
            throw new ApiError(
              400,
              "bad_request",
              `unsupported assistant content block type: ${typeof b["type"] === "string" ? b["type"] : "(missing)"}`,
            );
        }
      }
      out.push({
        role: "assistant",
        content: text,
        images: [],
        audio: [],
        tool_calls: calls.length > 0 ? calls : null,
        tool_call_id: null,
        reasoning: reasoning !== "" ? reasoning : null,
      });
    } else {
      // user turns: tool_result blocks become tool messages FIRST (a user
      // message between the assistant's tool_calls and the results is
      // rejected by both provider adapters), then the turn's accompanying
      // text/image as the user message after them.
      let text = "";
      const images: string[] = [];
      for (const b of blocks) {
        const type = typeof b["type"] === "string" ? b["type"] : "";
        if (type === "text") {
          if (text !== "") text += "\n";
          text += typeof b["text"] === "string" ? b["text"] : "";
        } else if (type === "image") {
          images.push(imageUri(b));
        } else if (type === "tool_result") {
          out.push(toolResultMessage(b));
        } else {
          throw new ApiError(
            400,
            "bad_request",
            `unsupported user content block type: ${typeof b["type"] === "string" ? b["type"] : "(missing)"}`,
          );
        }
      }
      if (text !== "" || images.length > 0) {
        out.push({
          role: "user",
          content: text,
          images,
          audio: [],
          tool_calls: null,
          tool_call_id: null,
          reasoning: null,
        });
      }
    }
  }
  return [system, out];
}

/** One `tool_result` block as an internal tool message: the content keeps
 *  its text and image parts (a bare string is the text form). */
function toolResultMessage(b: Record<string, unknown>): InternalMessage {
  const images: string[] = [];
  let content = "";
  const raw = b["content"];
  if (typeof raw === "string") {
    content = raw;
  } else if (Array.isArray(raw)) {
    const texts: string[] = [];
    for (const p of raw as Record<string, unknown>[]) {
      const type = typeof p["type"] === "string" ? p["type"] : "";
      if (type === "image") {
        images.push(imageUri(p));
      } else if (type === "text") {
        texts.push(typeof p["text"] === "string" ? p["text"] : "");
      } else {
        throw new ApiError(
          400,
          "bad_request",
          `unsupported tool result content part type: ${typeof p["type"] === "string" ? p["type"] : "(missing)"}`,
        );
      }
    }
    content = texts.join("\n");
  }
  return {
    role: "tool",
    content,
    images,
    audio: [],
    tool_calls: null,
    tool_call_id: typeof b["tool_use_id"] === "string" ? b["tool_use_id"] : "",
    reasoning: null,
  };
}

/** An Anthropic image block's source as an internal image part: base64 →
 *  data URI, url → the URL itself (providers forward both). Other source
 *  types (e.g. `file`) have no internal form. */
function imageUri(block: Record<string, unknown>): string {
  const source = (block["source"] as Record<string, unknown> | undefined) ?? {};
  switch (typeof source["type"] === "string" ? source["type"] : "") {
    case "base64": {
      const data = typeof source["data"] === "string" && source["data"] !== "" ? source["data"] : null;
      if (data === null) throw new ApiError(400, "bad_request", "base64 image source is missing its data");
      return `data:${typeof source["media_type"] === "string" ? source["media_type"] : "image/png"};base64,${data}`;
    }
    case "url": {
      const url = typeof source["url"] === "string" ? source["url"] : "";
      if (url.startsWith("https://") || url.startsWith("http://")) return url;
      throw new ApiError(400, "bad_request", "url image source needs an http(s) url");
    }
    default:
      throw new ApiError(
        400,
        "bad_request",
        `unsupported image source type ${typeof source["type"] === "string" ? source["type"] : "(missing)"}`,
      );
  }
}

function toToolSpecs(tools: AnthropicTool[]): ToolSpec[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description ?? "",
    parameters: t.input_schema ?? { type: "object", properties: {} },
  }));
}

/** The provider's reasoning leads the content, mirroring how it streams
 *  (thinking before text) so non-stream clients can replay it. */
function contentBlocks(reasoning: string, text: string, calls: ToolCall[]): unknown {
  const blocks: unknown[] = [];
  if (reasoning !== "") {
    blocks.push({ type: "thinking", thinking: reasoning });
  }
  if (text !== "") {
    blocks.push({ type: "text", text });
  }
  for (const c of calls) {
    blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments });
  }
  if (blocks.length === 0) {
    blocks.push({ type: "text", text: "" });
  }
  return blocks;
}

export function registerAnthropicRoutes(app: FastifyInstance, gateway: GatewayContext, ctx: PlatformContext): void {
  app.post("/anthropic/v1/messages", async (req, reply) => {
    let credential: GatewayCredential;
    try {
      credential = await anthropicCredential(ctx, req);
    } catch (error) {
      const apiError = error as ApiError;
      return reply
        .status(apiError.status)
        .type("application/json")
        .send(anthropicErrorShape("authentication_error", apiError.message));
    }
    try {
      await handleMessages(gateway, credential, req, reply);
    } catch (error) {
      const rendered = renderAnthropicError(error);
      return reply.status(rendered.status).type("application/json").send(rendered.body);
    }
  });
}

function invalidRequest(message: string): ApiError {
  return new ApiError(400, "invalid_request_error", message);
}

async function handleMessages(
  gateway: GatewayContext,
  credential: GatewayCredential,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const body = requireJsonBody(req) as Record<string, unknown>;
  if (body["model"] === undefined) {
    throw new TextError(
      422,
      `${DESERIALIZE_PREFIX}missing field \`model\` at line 1 column ${(req as never as Record<symbol, string>)[RAW_BODY]?.length ?? 0}`,
    );
  }
  if (body["messages"] === undefined) {
    throw new TextError(
      422,
      `${DESERIALIZE_PREFIX}missing field \`messages\` at line 1 column ${(req as never as Record<symbol, string>)[RAW_BODY]?.length ?? 0}`,
    );
  }
  const req0 = body as unknown as AnthropicRequest;
  // A nonpositive client limit is invalid (the OpenAI ingress rejects it
  // too): passed through, it would erase the route's output cap.
  if (req0.max_tokens !== undefined && (typeof req0.max_tokens !== "number" || req0.max_tokens <= 0)) {
    throw invalidRequest("output token limit must be positive");
  }
  const [system, internal] = toInternal(req0);
  const tools = req0.tools !== undefined && req0.tools !== null ? toToolSpecs(req0.tools) : null;

  const call = await dispatch(gateway, credential.orgId, req0.model, system, internal, tools, req0.max_tokens ?? null);
  const model = call.model;
  const provider = call.provider;

  if (req0.stream === true) {
    streamEvents(gateway, credential, reply, call);
    return;
  }
  const counters = new StreamUsageCounters();
  let acc;
  try {
    acc = await accumulate(call.stream, counters);
  } catch (error) {
    recordUsageDropped(gateway.usage, credential, model, provider, call.priceIn, call.priceOut, counters);
    throw new ApiError(502, "provider_error", error instanceof ProviderError ? error.message : String(error));
  }
  await recordUsageSync(call.usage, credential, model, provider, call.priceIn, call.priceOut, counters);
  // The provider's reported terminal reason maps into the Anthropic
  // vocabulary; without one the shape decides (today's fallback).
  const stop = mapStopReason(acc.finishReason, acc.calls.length === 0);
  reply.type("application/json").send(
    rustJsonText({
      id: `msg_${uuidv7()}`,
      type: "message",
      role: "assistant",
      model,
      content: contentBlocks(acc.reasoning, acc.text, acc.calls),
      stop_reason: stop,
      stop_sequence: null,
      usage: { input_tokens: acc.tokensIn, output_tokens: acc.tokensOut },
    }),
  );
}

function mapStopReason(reported: string | null, noCalls: boolean): string {
  switch (reported) {
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return noCalls ? "end_turn" : "tool_use";
  }
}

/** ProviderChunk stream → Anthropic SSE event sequence. Blocks open/close
 *  exactly once; text, thinking and tool_use alternate freely. The usage
 *  guard records exactly once on every exit path (normal completion
 *  records synchronously before the final frame; the dropped path covers
 *  provider errors after frames and client disconnects). */
function streamEvents(
  gateway: GatewayContext,
  credential: GatewayCredential,
  reply: FastifyReply,
  call: RoutedCall,
): void {
  const counters = new StreamUsageCounters();
  const msgId = `msg_${uuidv7()}`;
  const model = call.model;
  const send = (event: string, data: unknown): string => `event: ${event}\ndata: ${rustJsonText(data)}\n\n`;

  let nextBlock = -1;
  let currentBlock: number | null = null;
  let currentType: string | null = null;
  const toolBlocks = new Map<number, number>();
  const pendingStops: number[] = [];
  let tokensIn = 0;
  let tokensOut = 0;

  const closeCurrent = (): string | null => {
    const idx = currentBlock;
    if (idx === null) return null;
    currentBlock = null;
    currentType = null;
    const at = pendingStops.indexOf(idx);
    if (at !== -1) pendingStops.splice(at, 1);
    return send("content_block_stop", { type: "content_block_stop", index: idx });
  };
  const openBlock = (contentBlock: Record<string, unknown>, ty: string): { frame: string; idx: number } => {
    const closed = closeCurrent();
    nextBlock += 1;
    const idx = nextBlock;
    const frame =
      (closed ?? "") +
      send("content_block_start", {
        type: "content_block_start",
        index: idx,
        content_block: contentBlock,
      });
    pendingStops.push(idx);
    currentBlock = idx;
    currentType = ty;
    return { frame, idx };
  };

  let stopReason: string | null = null;

  const frames = async function* (): AsyncIterable<string> {
    let settled = false;
    try {
      yield send("message_start", {
        type: "message_start",
        message: {
          id: msgId,
          type: "message",
          role: "assistant",
          model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });

      for await (const item of call.stream) {
        if (item instanceof ProviderError) {
          yield send("error", { type: "error", error: { type: "api_error", message: item.message } });
          return;
        }
        // Only Ok items count as served frames: an in-stream provider error
        // before any real chunk must not bill a 0-token request.
        counters.observe();
        if (item.kind === "text") {
          if (item.textDelta !== "") {
            if (currentType !== "text") {
              const opened = openBlock({ type: "text", text: "" }, "text");
              yield opened.frame;
            }
            yield send("content_block_delta", {
              type: "content_block_delta",
              index: currentBlock!,
              delta: { type: "text_delta", text: item.textDelta },
            });
          }
          if (item.tokensIn !== undefined) tokensIn = item.tokensIn;
          if (item.tokensOut !== undefined) tokensOut = item.tokensOut;
          counters.set(item.tokensIn, item.tokensOut);
        } else if (item.kind === "thinking") {
          if (item.textDelta !== "") {
            if (currentType !== "thinking") {
              const opened = openBlock({ type: "thinking", thinking: "" }, "thinking");
              yield opened.frame;
            }
            yield send("content_block_delta", {
              type: "content_block_delta",
              index: currentBlock!,
              delta: { type: "thinking_delta", thinking: item.textDelta },
            });
          }
        } else if (item.kind === "toolCallDelta") {
          const existing = toolBlocks.get(item.index);
          let block: number;
          if (existing !== undefined) {
            block = existing;
          } else {
            const opened = openBlock(
              {
                type: "tool_use",
                id: item.id ?? `toolu_${uuidv7()}`,
                name: item.name ?? "",
                input: {},
              },
              "tool_use",
            );
            toolBlocks.set(item.index, opened.idx);
            block = opened.idx;
            yield opened.frame;
          }
          if (item.argumentsDelta !== "") {
            yield send("content_block_delta", {
              type: "content_block_delta",
              index: block,
              delta: { type: "input_json_delta", partial_json: item.argumentsDelta },
            });
          }
        } else if (item.kind === "toolCallDone") {
          // A call whose fragments never streamed (folded at the adapter
          // layer): emit the whole tool block at once and close it. When
          // fragments did stream, the block is already open and the Done
          // frame adds nothing.
          if (toolBlocks.size === 0) {
            const opened = openBlock(
              { type: "tool_use", id: item.call.id, name: item.call.name, input: {} },
              "tool_use",
            );
            yield opened.frame;
            yield send("content_block_delta", {
              type: "content_block_delta",
              index: opened.idx,
              delta: {
                type: "input_json_delta",
                partial_json: rustJsonText(item.call.arguments),
              },
            });
            const closed = closeCurrent();
            if (closed !== null) yield closed;
          }
        } else {
          stopReason = item.reason;
        }
      }

      const closed = closeCurrent();
      if (closed !== null) yield closed;
      for (const idx of pendingStops) {
        yield send("content_block_stop", { type: "content_block_stop", index: idx });
      }
      // A reported terminal reason maps into the Anthropic vocabulary; the
      // shape decides when none arrived (today's fallback).
      const stop = mapStopReason(stopReason, toolBlocks.size === 0);
      yield send("message_delta", {
        type: "message_delta",
        delta: { stop_reason: stop, stop_sequence: null },
        usage: { output_tokens: tokensOut, input_tokens: tokensIn },
      });
      await recordUsageSync(
        gateway.usage,
        credential,
        model,
        call.provider,
        call.priceIn,
        call.priceOut,
        counters,
      );
      settled = true;
      yield send("message_stop", { type: "message_stop" });
    } finally {
      if (!settled) {
        recordUsageDropped(
          gateway.usage,
          credential,
          model,
          call.provider,
          call.priceIn,
          call.priceOut,
          counters,
        );
      }
    }
  }();

  sseReply(reply, frames);
}
