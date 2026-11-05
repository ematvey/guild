// OpenAI-shaped wire protocol (crates/guild-core/src/provider/openai.rs
// port): `POST {base}/v1/chat/completions` with `stream: true`. Covers
// OpenAI and every OpenAI-compatible provider.

import {
  hasMedia,
  ProviderError,
  type ModelProvider,
  type ProviderChunk,
  type ProviderRequest,
  type ToolCall,
} from "./types.js";
import type { Json } from "@guild/wire/rest";
import { headerDeadline, sseDataStreams } from "./sse.js";

/** The output-token-limit dialect for a model name: OpenAI reasoning
 *  families (`o1*`, `o3*`, `o4*`, `gpt-5*` — matched on the final path
 *  segment after `/` so provider-prefixed names and variant suffixes count)
 *  take `max_completion_tokens`; every other OpenAI-compatible backend takes
 *  `max_tokens`. */
function usesCompletionTokens(model: string): boolean {
  const name = model.split("/").pop() ?? model;
  const lower = name.toLowerCase();
  return lower.startsWith("o1") || lower.startsWith("o3") || lower.startsWith("o4") || lower.startsWith("gpt-5");
}

/** Builds the upstream request body from the internal messages. */
export function openAiBody(req: ProviderRequest): Record<string, unknown> {
  const messages: unknown[] = [];
  if (req.system !== null) {
    messages.push({ role: "system", content: req.system });
  }
  // Chat Completions accepts only text content on `role:"tool"` messages;
  // media attached to a tool result rides in a user message emitted after
  // the run of tool results.
  let pendingToolMedia: unknown[] = [];
  for (const m of req.messages) {
    if (m.role === "tool") {
      const mv: Record<string, unknown> = { role: "tool", content: m.content };
      if (m.tool_call_id !== undefined && m.tool_call_id !== null) mv["tool_call_id"] = m.tool_call_id;
      messages.push(mv);
      for (const uri of m.images ?? []) {
        pendingToolMedia.push({ type: "image_url", image_url: { url: uri } });
      }
      continue;
    }
    if (pendingToolMedia.length > 0) {
      const parts = pendingToolMedia;
      pendingToolMedia = [];
      messages.push({ role: "user", content: parts });
    }
    // Multimodal user turns: text plus image/audio content parts. Text-only
    // messages keep the plain string form.
    const content: unknown = hasMedia(m)
      ? [
          ...(m.content !== "" ? [{ type: "text", text: m.content }] : []),
          ...(m.images ?? []).map((uri) => ({ type: "image_url", image_url: { url: uri } })),
          ...(m.audio ?? []).map((a) => ({ type: "input_audio", input_audio: { data: a.data, format: a.format } })),
        ]
      : m.content;
    const mv: Record<string, unknown> = { role: m.role, content };
    if (m.tool_calls !== undefined && m.tool_calls !== null) {
      mv["tool_calls"] = m.tool_calls.map((c) => ({
        id: c.id,
        type: "function",
        function: {
          name: c.name,
          arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? null),
        },
      }));
    }
    if (m.tool_call_id !== undefined && m.tool_call_id !== null) mv["tool_call_id"] = m.tool_call_id;
    // dsh rule: reasoning is resent on EVERY reasoning-carrying turn, never
    // dropped from context (design §B.1).
    if (m.reasoning !== null && m.reasoning !== "") {
      mv["reasoning_content"] = m.reasoning;
    }
    messages.push(mv);
  }
  if (pendingToolMedia.length > 0) {
    messages.push({ role: "user", content: pendingToolMedia });
  }
  const body: Record<string, unknown> = {
    model: req.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  // 0 = provider default: the field stays absent. Exactly one of the two
  // fields is ever sent — the dialect is picked from the model name (the
  // route protocol is "openai" for both reasoning and classic backends).
  if (req.maxTokens > 0) {
    body[usesCompletionTokens(req.model) ? "max_completion_tokens" : "max_tokens"] = req.maxTokens;
  }
  if (req.temperature !== null) {
    body["temperature"] = req.temperature;
  }
  if (req.tools !== null) {
    body["tools"] = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  return body;
}

interface OpenAiFrame {
  chunks: ProviderChunk[];
  toolCallDeltas: { index: number; id?: string; name?: string; arguments?: string }[];
  finishReason?: string;
  hasError: boolean;
  errorMessage: string;
}

/** Parses one SSE data frame (a JSON value or "[DONE]"). */
export function parseOpenAiFrame(data: string): OpenAiFrame {
  const empty: OpenAiFrame = { chunks: [], toolCallDeltas: [], hasError: false, errorMessage: "" };
  if (data === "[DONE]") return empty;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return empty;
  }
  if (v["error"] !== undefined && v["error"] !== null) {
    const err = v["error"] as Record<string, unknown>;
    const msg = typeof err["message"] === "string" ? err["message"] : JSON.stringify(err["error"] ?? err);
    return { chunks: [], toolCallDeltas: [], hasError: true, errorMessage: msg };
  }
  const usage = v["usage"] as Record<string, unknown> | null | undefined;
  const tokensIn = numberField(usage?.["prompt_tokens"]);
  const tokensOut = numberField(usage?.["completion_tokens"]);
  const details = usage?.["completion_tokens_details"] as Record<string, unknown> | undefined;
  const reasoningTokens = numberField(details?.["reasoning_tokens"]);
  const choice = ((v["choices"] as unknown[] | undefined) ?? [])[0] as Record<string, unknown> | undefined;
  const delta = (choice?.["delta"] as Record<string, unknown> | undefined) ?? {};
  const chunks: ProviderChunk[] = [];
  // vLLM emits `reasoning`; most OpenAI-compatible backends emit
  // `reasoning_content`. Both carry the same thinking delta.
  const reasoning = delta["reasoning_content"] ?? delta["reasoning"];
  if (typeof reasoning === "string" && reasoning !== "") {
    chunks.push({ kind: "thinking", textDelta: reasoning, tokensIn, tokensOut, reasoningTokens });
  }
  const textDelta = typeof delta["content"] === "string" ? delta["content"] : "";
  if (textDelta !== "" || (chunks.length === 0 && (tokensIn !== undefined || tokensOut !== undefined))) {
    chunks.push({ kind: "text", textDelta, tokensIn, tokensOut, reasoningTokens });
  }
  const toolCallDeltas: OpenAiFrame["toolCallDeltas"] = [];
  const tcs = delta["tool_calls"];
  if (Array.isArray(tcs)) {
    for (const tc of tcs as Record<string, unknown>[]) {
      const fn = (tc["function"] as Record<string, unknown> | undefined) ?? {};
      toolCallDeltas.push({
        index: typeof tc["index"] === "number" ? tc["index"] : 0,
        id: typeof tc["id"] === "string" ? tc["id"] : undefined,
        name: typeof fn["name"] === "string" ? fn["name"] : undefined,
        arguments: typeof fn["arguments"] === "string" ? fn["arguments"] : undefined,
      });
    }
  }
  const finishReason = typeof choice?.["finish_reason"] === "string" ? choice["finish_reason"] : undefined;
  return { chunks, toolCallDeltas, finishReason, hasError: false, errorMessage: "" };
}

function numberField(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

/** Upper bound on parallel tool-call streams accepted from one delta
 *  sequence; anything beyond is treated as a garbage index. */
const MAX_TOOL_CALL_PARTIALS = 256;

interface PartialCall {
  id: string;
  name: string;
  arguments: string;
}

export const openAiProvider: ModelProvider = {
  async chatStream(req: ProviderRequest): Promise<AsyncIterable<ProviderChunk | ProviderError>> {
    const url = `${req.baseUrl.replace(/\/+$/, "")}/v1/chat/completions`;
    // The deadline covers the wait for response headers only. It must be
    // cleared once they arrive: an abort signal stays armed on the body, so
    // a long stream would be cut at the same second. The body has its own
    // bound (the idle read in sseDataStreams).
    const headers = headerDeadline();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${req.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(openAiBody(req)),
        signal: headers.signal,
      });
    } catch (error) {
      // Every phase bounded: connect (15s), response headers (60s) — a
      // provider that accepts the connection and then stalls must never pin
      // the caller.
      throw ProviderError.stream(
        (error as { name?: string }).name === "TimeoutError" ? "provider did not respond within 60s" : errorText(error),
      );
    } finally {
      headers.done();
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw ProviderError.fromStatus(res.status, body);
    }
    return openAiStream(res);
  },
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The provider SSE stream: parses frames, assembles tool calls, and fails
 *  when the stream ends without a completion marker. */
async function* openAiStream(res: Response): AsyncIterable<ProviderChunk | ProviderError> {
  const partials: PartialCall[] = [];
  let finishToolCalls = false;
  let completed = false;
  for await (const frame of sseDataStreams(res, "openai")) {
    if (frame instanceof ProviderError) {
      yield frame;
      return;
    }
    const data = frame.trim();
    if (data === "[DONE]") {
      completed = true;
      break;
    }
    if (data === "") continue;
    const parsed = parseOpenAiFrame(data);
    if (parsed.hasError) {
      yield ProviderError.upstream(parsed.errorMessage);
      return;
    }
    for (const chunk of parsed.chunks) yield chunk;
    for (const tc of parsed.toolCallDeltas) {
      const idx = tc.index;
      // Garbage indices from misbehaving providers must not grow the
      // partial list unboundedly.
      if (idx < 0 || idx >= MAX_TOOL_CALL_PARTIALS) continue;
      while (partials.length <= idx) partials.push({ id: "", name: "", arguments: "" });
      const p = partials[idx]!;
      if (tc.id !== undefined) p.id = tc.id;
      if (tc.name !== undefined) p.name = tc.name;
      if (tc.arguments !== undefined) p.arguments += tc.arguments;
      yield {
        kind: "toolCallDelta",
        index: idx,
        id: tc.id,
        name: tc.name,
        argumentsDelta: tc.arguments ?? "",
      };
    }
    if (parsed.finishReason !== undefined) {
      completed = true;
      if (parsed.finishReason === "tool_calls") finishToolCalls = true;
      yield { kind: "finished", reason: parsed.finishReason };
    }
  }
  if (!completed) {
    yield ProviderError.stream("provider stream ended before a completion marker");
    return;
  }
  if (finishToolCalls) {
    for (const p of partials) {
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
      const call: ToolCall = { id: p.id, name: p.name, arguments: argumentsValue as Json };
      yield { kind: "toolCallDone", call };
    }
  }
}
