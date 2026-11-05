// The provider header deadline: it bounds the wait for response headers and
// nothing else. An abort signal stays armed on the response body, so a
// signal left ticking after the headers arrive cuts every long stream at the
// same second — the bug that ended agent turns with "Stream ended without
// finish_reason" at exactly 60s.

import { afterEach, describe, expect, it, vi } from "vitest";
import { openAiProvider } from "../../platform/provider/openai.js";
import { anthropicProvider } from "../../platform/provider/anthropic.js";
import type { ProviderChunk, ProviderError, ProviderRequest } from "../../platform/provider/types.js";

const request: ProviderRequest = {
  model: "m1",
  system: null,
  messages: [{ role: "user", content: "hello" }],
  apiKey: "k",
  baseUrl: "http://provider.test",
  tools: null,
  maxTokens: 0,
  temperature: null,
};

async function collect(stream: AsyncIterable<ProviderChunk | ProviderError>): Promise<(ProviderChunk | ProviderError)[]> {
  const items: (ProviderChunk | ProviderError)[] = [];
  for await (const item of stream) items.push(item);
  return items;
}

/** A body that yields its frames only when `release()` is called. */
function gatedStream(frames: string[]): { body: ReadableStream<Uint8Array>; release(): void } {
  const encoder = new TextEncoder();
  let open: (() => void) | null = null;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      await opened;
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return { body, release: () => open?.() };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the provider header deadline", () => {
  it("fails a provider that never sends headers, at 60s", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", (_url: string, init: { signal: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(init.signal.reason));
      }),
    );
    const pending = openAiProvider.chatStream(request);
    const settled = expect(pending).rejects.toThrow(/did not respond within 60s/);
    await vi.advanceTimersByTimeAsync(60_000);
    await settled;
  });

  it("leaves the body alive past 60s once the headers arrive", async () => {
    vi.useFakeTimers();
    const gate = gatedStream([
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ]);
    let seen: AbortSignal | null = null;
    vi.stubGlobal("fetch", (_url: string, init: { signal: AbortSignal }) => {
      seen = init.signal;
      return Promise.resolve(new Response(gate.body, { status: 200 }));
    });
    const stream = await openAiProvider.chatStream(request);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(seen!.aborted).toBe(false);
    gate.release();
    const items = await collect(stream);
    expect(items.some((item) => item.kind === "text")).toBe(true);
    expect(items.some((item) => item.kind === "finished")).toBe(true);
  });

  it("does the same on the Anthropic shape", async () => {
    vi.useFakeTimers();
    const gate = gatedStream([
      'data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}\n\n',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
      'data: {"type":"message_stop"}\n\n',
    ]);
    let seen: AbortSignal | null = null;
    vi.stubGlobal("fetch", (_url: string, init: { signal: AbortSignal }) => {
      seen = init.signal;
      return Promise.resolve(new Response(gate.body, { status: 200 }));
    });
    const stream = await anthropicProvider.chatStream(request);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(seen!.aborted).toBe(false);
    gate.release();
    const items = await collect(stream);
    expect(items.some((item) => item.kind === "finished")).toBe(true);
  });
});
