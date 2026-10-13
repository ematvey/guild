// Model provider abstraction (crates/guild-core/src/provider/mod.rs port):
// every supported provider conforms to either the OpenAI wire shape or the
// Anthropic wire shape. Route resolution keys off the wire protocol, never
// off the provider's display name.

/** One audio part on a user turn (OpenAI `input_audio` contract). */
export interface MessageAudio {
  data: string;
  format: string;
}

/** One tool invocation on an assistant turn. `arguments` carries the parsed
 *  JSON object (or a raw unparseable upstream buffer kept verbatim). */
export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

/** A declared tool for agentic turns. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: unknown;
}

/** The internal model-facing message (protocol::api::Message). Images ride
 *  as data URIs; reasoning is replayed to the model, never dropped. */
export interface InternalMessage {
  role: string;
  content: string;
  images: string[];
  audio: MessageAudio[];
  tool_calls: ToolCall[] | null;
  tool_call_id: string | null;
  reasoning: string | null;
}

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
