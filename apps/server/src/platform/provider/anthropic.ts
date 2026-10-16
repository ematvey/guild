// Anthropic-shaped wire protocol (crates/guild-core/src/provider/
// anthropic.rs port): `POST {base}/v1/messages` with `x-api-key` +
// `anthropic-version` headers and `stream: true`.

import {
  hasMedia,
  ProviderError,
  type ModelProvider,
  type ProviderChunk,
  type ProviderRequest,
  type ToolCall,
} from "./types.js";
import type { JsonValue } from "@guild/protocol/serde_json/JsonValue.js";
import { sseDataStreams } from "./sse.js";

/** Anthropic requires an explicit cap on every request. */
const DEFAULT_MAX_TOKENS = 4096;

/** Splits `data:<media_type>;base64,<data>` into (media_type, data). */
function parseDataUri(uri: string): [string, string] | null {
  if (!uri.startsWith("data:")) return null;
  const rest = uri.slice("data:".length);
  const semi = rest.indexOf(";base64,");
  if (semi === -1) return null;
  const mediaType = rest.slice(0, semi);
  const data = rest.slice(semi + ";base64,".length);
  if (mediaType === "" || data === "") return null;
  return [mediaType, data];
}

/** Builds the upstream body: Anthropic conversation shape — assistant
 *  tool_use blocks and tool results as user "tool_result" blocks. */
export function anthropicBody(req: ProviderRequest): Record<string, unknown> {
  const messages: Record<string, unknown>[] = [];
  for (const m of req.messages) {
    if (m.role === "tool") {
      // Anthropic tool_result: plain string when text-only; image parts
      // ride as content blocks (text + base64 images).
      const content: unknown =
        m.images.length === 0
          ? m.content
          : [
              ...(m.content !== "" ? [{ type: "text", text: m.content }] : []),
              ...m.images.map((uri) => imageBlock(uri)),
            ];
      const result = {
        type: "tool_result",
        tool_use_id: m.tool_call_id ?? "",
        content,
      };
      const last = messages[messages.length - 1];
      if (last !== undefined && last["role"] === "user" && Array.isArray(last["content"])) {
        (last["content"] as unknown[]).push(result);
        continue;
      }
      messages.push({ role: "user", content: [result] });
      continue;
    }
    if (m.role === "assistant") {
      // Reasoning replay: Anthropic requires thinking blocks echoed with
      // their original signature; replaying them as plain text is wrong, so
      // reasoning is deliberately left unreplayed for anthropic routes
      // (kept in the thread log, never dropped there) — design §B.1.
      if (m.tool_calls === null) {
        // An empty completion or an interrupted reasoning-only turn
        // persists no content; Anthropic rejects empty assistant content.
        if (m.content.trim() === "") continue;
        messages.push({ role: m.role, content: m.content });
        continue;
      }
      const blocks: unknown[] = [];
      if (m.content.trim() !== "") {
        blocks.push({ type: "text", text: m.content });
      }
      for (const c of m.tool_calls ?? []) {
        // A tool_use block truncated by max_tokens persists partial JSON (a
        // non-object value); the wire requires an object, so anything else
        // goes as an empty input.
        const input = c.arguments !== null && typeof c.arguments === "object" ? c.arguments : {};
        blocks.push({ type: "tool_use", id: c.id, name: c.name, input });
      }
      messages.push({ role: "assistant", content: blocks });
      continue;
    }
    // A user turn right after tool results rides in the SAME user content
    // array, after them — the documented [tool_result…, text] continuation
    // form; a separate user message following the tool_use turn carries no
    // result and is rejected by the strict contract.
    const last = messages[messages.length - 1];
    const followsToolResults =
      last !== undefined &&
      last["role"] === "user" &&
      Array.isArray(last["content"]) &&
      (last["content"] as Record<string, unknown>[]).some((b) => b["type"] === "tool_result");
    // Multimodal user turns: image blocks — data URIs ride as base64
    // sources, remote http(s) URLs as Anthropic url sources (both
    // upstream-supported). Audio has no Anthropic input form: it is
    // REJECTED here, never silently dropped — a text-only request would
    // look successful while the model never saw the user's audio.
    if (hasMedia(m)) {
      const blocks: unknown[] = [];
      if (m.content.trim() !== "") {
        blocks.push({ type: "text", text: m.content });
      }
      for (const uri of m.images) {
        blocks.push(imageBlock(uri));
      }
      if (m.audio.length > 0) {
        throw ProviderError.upstream(
          "audio input parts are not supported by the anthropic protocol (they are accepted only on openai-shape routes)",
        );
      }
      if (followsToolResults) {
        (last!["content"] as unknown[]).push(...blocks);
      } else {
        messages.push({ role: m.role, content: blocks });
      }
      continue;
    }
    if (followsToolResults && m.content.trim() !== "") {
      (last!["content"] as unknown[]).push({ type: "text", text: m.content });
      continue;
    }
    messages.push({ role: m.role, content: m.content });
  }
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens > 0 ? req.maxTokens : DEFAULT_MAX_TOKENS,
    messages,
    stream: true,
  };
  if (req.system !== null) {
    body["system"] = req.system;
  }
  if (req.temperature !== null) {
    body["temperature"] = req.temperature;
  }
  if (req.tools !== null) {
    body["tools"] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }
  return body;
}

/** An image reference as an Anthropic content block. Data URIs become
 *  base64 sources; http(s) URLs ride as url sources; anything else is a
 *  failure the caller renders (never a silent drop). */
function imageBlock(uri: string): unknown {
  const parsed = parseDataUri(uri);
  if (parsed !== null) {
    const [mediaType, data] = parsed;
    return { type: "image", source: { type: "base64", media_type: mediaType, data } };
  }
  if (uri.startsWith("http://") || uri.startsWith("https://")) {
    return { type: "image", source: { type: "url", url: uri } };
  }
  throw ProviderError.upstream(`unsupported image reference on an anthropic route: ${uri}`);
}

interface AnthropicFrame {
  chunk: (ProviderChunk & { kind: "text" | "thinking" }) | null;
  finishedReason: string | null;
  stopFrame: boolean;
  toolUseStart: { index: number; id: string; name: string } | null;
  inputJsonDelta: { index: number; partialJson: string } | null;
  blockStopIndex: number | null;
  isError: boolean;
  errorMessage: string;
}

/** Parses one SSE data frame (Anthropic event payloads). */
export function parseAnthropicFrame(data: string): AnthropicFrame {
  const none: AnthropicFrame = {
    chunk: null,
    finishedReason: null,
    stopFrame: false,
    toolUseStart: null,
    inputJsonDelta: null,
    blockStopIndex: null,
    isError: false,
    errorMessage: "",
  };
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(data.trim()) as Record<string, unknown>;
  } catch {
    return none;
  }
  const type = typeof v["type"] === "string" ? v["type"] : "";
  if (type === "error") {
    const err = (v["error"] as Record<string, unknown> | undefined) ?? {};
    const etype = typeof err["type"] === "string" ? err["type"] : "error";
    const msg = typeof err["message"] === "string" ? err["message"] : "upstream error";
    return { ...none, isError: true, errorMessage: `${etype}: ${msg}` };
  }
  if (type === "message_delta") {
    const stopReason = (v["delta"] as Record<string, unknown> | undefined)?.["stop_reason"];
    const usage = v["usage"] as Record<string, unknown> | undefined;
    const tokensOut = typeof usage?.["output_tokens"] === "number" ? usage["output_tokens"] : undefined;
    const chunk = tokensOut !== undefined ? ({ kind: "text", textDelta: "", tokensOut } as const) : null;
    const finishedReason =
      typeof stopReason === "string"
        ? stopReason === "tool_use"
          ? "tool_calls"
          : stopReason === "max_tokens"
            ? "length"
            : // A refusal frame must not reach clients as a successful
              // stop: the canonical reason keeps the content_filter
              // semantics, which both gateway egress shapes map back.
              stopReason === "refusal"
              ? "content_filter"
              : "stop"
        : null;
    return { ...none, chunk, finishedReason, stopFrame: false };
  }
  if (type === "message_stop") {
    return { ...none, stopFrame: true };
  }
  const chunk = parseChunkFrame(v, type);
  let toolUseStart: AnthropicFrame["toolUseStart"] = null;
  let inputJsonDelta: AnthropicFrame["inputJsonDelta"] = null;
  let blockStopIndex: number | null = null;
  const idx = typeof v["index"] === "number" ? v["index"] : 0;
  if (type === "content_block_start") {
    const block = (v["content_block"] as Record<string, unknown> | undefined) ?? {};
    if (block["type"] === "tool_use") {
      toolUseStart = {
        index: idx,
        id: typeof block["id"] === "string" ? block["id"] : "",
        name: typeof block["name"] === "string" ? block["name"] : "",
      };
    }
  } else if (type === "content_block_delta") {
    const delta = (v["delta"] as Record<string, unknown> | undefined) ?? {};
    if (delta["type"] === "input_json_delta") {
      inputJsonDelta = {
        index: idx,
        partialJson: typeof delta["partial_json"] === "string" ? delta["partial_json"] : "",
      };
    }
  } else if (type === "content_block_stop") {
    blockStopIndex = idx;
  }
  return { ...none, chunk, toolUseStart, inputJsonDelta, blockStopIndex };
}

/** The usage/text chunks the Rust `parse_frame` extracts (everything else
 *  yields no chunk). */
function parseChunkFrame(
  v: Record<string, unknown>,
  type: string,
): (ProviderChunk & { kind: "text" | "thinking" }) | null {
  if (type === "message_start") {
    const message = (v["message"] as Record<string, unknown> | undefined) ?? {};
    const usage = (message["usage"] as Record<string, unknown> | undefined) ?? {};
    const tokensIn = typeof usage["input_tokens"] === "number" ? usage["input_tokens"] : undefined;
    if (tokensIn === undefined) return null;
    return { kind: "text", textDelta: "", tokensIn };
  }
  if (type === "content_block_delta") {
    const delta = (v["delta"] as Record<string, unknown> | undefined) ?? {};
    if (delta["type"] === "thinking_delta") {
      const thinking = typeof delta["thinking"] === "string" ? delta["thinking"] : "";
      if (thinking === "") return null;
      return { kind: "thinking", textDelta: thinking };
    }
    if (delta["type"] === "text_delta") {
      const text = typeof delta["text"] === "string" ? delta["text"] : "";
      if (text === "") return null;
      return { kind: "text", textDelta: text };
    }
  }
  if (type === "message_delta") {
    const usage = v["usage"] as Record<string, unknown> | undefined;
    const tokensOut = typeof usage?.["output_tokens"] === "number" ? usage["output_tokens"] : undefined;
    if (tokensOut === undefined) return null;
    return { kind: "text", textDelta: "", tokensOut };
  }
  return null;
}

interface PartialCall {
  id: string;
  name: string;
  arguments: string;
}

export const anthropicProvider: ModelProvider = {
  async chatStream(req: ProviderRequest): Promise<AsyncIterable<ProviderChunk | ProviderError>> {
    const url = `${req.baseUrl.replace(/\/+$/, "")}/v1/messages`;
    let body: Record<string, unknown>;
    try {
      body = anthropicBody(req);
    } catch (error) {
      // Audio/unsupported-image rejections happen before any upstream call.
      throw error as ProviderError;
    }
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "x-api-key": req.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      throw ProviderError.stream(
        (error as { name?: string }).name === "TimeoutError"
          ? "provider did not respond within 60s"
          : error instanceof Error
            ? error.message
            : String(error),
      );
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw ProviderError.fromStatus(res.status, text);
    }
    return anthropicStream(res);
  },
};

/** The provider SSE stream: per-block partial tool calls keyed by block
 *  index, stop-reason mapping, completion on message_stop. */
async function* anthropicStream(res: Response): AsyncIterable<ProviderChunk | ProviderError> {
  const partials = new Map<number, PartialCall>();
  let completed = false;
  for await (const frame of sseDataStreams(res, "anthropic")) {
    if (frame instanceof ProviderError) {
      yield frame;
      return;
    }
    const data = frame.trim();
    if (data === "") continue;
    const parsed = parseAnthropicFrame(data);
    if (parsed.isError) {
      // Mid-stream error frame (overloaded, rate limit, ...): surface it
      // instead of silently ending the turn.
      yield ProviderError.upstream(parsed.errorMessage);
      return;
    }
    if (parsed.finishedReason !== null) {
      yield { kind: "finished", reason: parsed.finishedReason };
    }
    if (parsed.stopFrame) {
      completed = true;
      break;
    }
    if (parsed.chunk !== null) yield parsed.chunk;
    const { toolUseStart, inputJsonDelta, blockStopIndex } = parsed;
    if (toolUseStart !== null) {
      partials.set(toolUseStart.index, {
        id: toolUseStart.id,
        name: toolUseStart.name,
        arguments: "",
      });
      yield {
        kind: "toolCallDelta",
        index: toolUseStart.index,
        id: toolUseStart.id,
        name: toolUseStart.name,
        argumentsDelta: "",
      };
    }
    if (inputJsonDelta !== null) {
      const p = partials.get(inputJsonDelta.index);
      if (p !== undefined) p.arguments += inputJsonDelta.partialJson;
      yield {
        kind: "toolCallDelta",
        index: inputJsonDelta.index,
        argumentsDelta: inputJsonDelta.partialJson,
      };
    }
    if (blockStopIndex !== null) {
      const p = partials.get(blockStopIndex);
      if (p !== undefined) {
        partials.delete(blockStopIndex);
        let argumentsValue: unknown;
        if (p.arguments.trim() === "") {
          argumentsValue = {};
        } else {
          try {
            argumentsValue = JSON.parse(p.arguments);
          } catch {
            argumentsValue = p.arguments;
          }
        }
        const call: ToolCall = { id: p.id, name: p.name, arguments: argumentsValue as JsonValue };
        yield { kind: "toolCallDone", call };
      }
    }
  }
  if (!completed) {
    yield ProviderError.stream("provider stream ended before message_stop");
  }
}
