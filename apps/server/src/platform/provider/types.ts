// Model provider abstraction (crates/guild-core/src/provider/mod.rs port):
// every supported provider conforms to either the OpenAI wire shape or the
// Anthropic wire shape. Route resolution keys off the wire protocol, never
// off the provider's display name.
//
// Message/ToolCall/ToolSpec/MessageAudio come from the generated protocol
// bindings (crates/protocol/bindings, from protocol::api) — single source of
// truth, no hand mirrors.
import type { Message } from "@guild/protocol/Message.js";
import type { MessageAudio } from "@guild/protocol/MessageAudio.js";
import type { ToolCall } from "@guild/protocol/ToolCall.js";
import type { ToolSpec } from "@guild/protocol/ToolSpec.js";

export type { MessageAudio, ToolCall, ToolSpec };

/** The internal model-facing message = protocol::api::Message. Optional
 *  fields are absent (not null) in payloads — serde defaults on the Rust
 *  side. */
export type InternalMessage = Message;

export function hasMedia(message: InternalMessage): boolean {
  return message.images.length > 0 || message.audio.length > 0;
}

/** One streamed piece of an assistant turn. */
export interface ChatChunk {
  textDelta: string;
  tokensIn?: number;
  tokensOut?: number;
}

export type ProviderChunk =
  | ({ kind: "text" } & ChatChunk)
  | ({ kind: "thinking" } & ChatChunk)
  | { kind: "toolCallDelta"; index: number; id?: string; name?: string; argumentsDelta: string }
  | { kind: "toolCallDone"; call: ToolCall }
  | { kind: "finished"; reason: string };

/** Provider-level failure; the message strings match the Rust Display impls
 *  (they surface verbatim in gateway error bodies). */
export class ProviderError extends Error {
  constructor(
    public kind: "auth" | "rateLimited" | "upstream" | "stream",
    message: string,
  ) {
    super(message);
  }

  static auth(): ProviderError {
    return new ProviderError("auth", "provider auth failed (check org key)");
  }

  static rateLimited(): ProviderError {
    return new ProviderError("rateLimited", "provider rate limited");
  }

  static upstream(message: string): ProviderError {
    return new ProviderError("upstream", `provider error: ${message}`);
  }

  static stream(message: string): ProviderError {
    return new ProviderError("stream", `provider stream failed: ${message}`);
  }

  static fromStatus(status: number, body: string): ProviderError {
    if (status === 401 || status === 403) return ProviderError.auth();
    if (status === 429) return ProviderError.rateLimited();
    return ProviderError.upstream(`status ${status}: ${body}`);
  }
}

export interface ProviderRequest {
  model: string;
  system: string | null;
  messages: InternalMessage[];
  apiKey: string;
  baseUrl: string;
  tools: ToolSpec[] | null;
  /** Max output tokens per call. 0 = provider default. Anthropic requires
   *  an explicit max_tokens; routes configure it (migration 0035). */
  maxTokens: number;
}

export interface ModelProvider {
  /** Opens the provider's SSE chat stream. */
  chatStream(req: ProviderRequest): Promise<AsyncIterable<ProviderChunk | ProviderError>>;
}

/** Wire-protocol → provider implementation ("openai" | "anthropic"). */
export function forProtocol(protocol: string): ModelProvider | null {
  if (protocol === "openai") return openAiProvider;
  if (protocol === "anthropic") return anthropicProvider;
  return null;
}

import { openAiProvider } from "./openai.js";
import { anthropicProvider } from "./anthropic.js";
