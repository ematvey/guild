// Server-Sent-Events stream decoder for provider responses: parses the
// wire bytes into `data:` payload strings (eventsource_stream semantics —
// multi-line data joined with \n, CRLF tolerated, comment/empty frames
// skipped). `event:` names are irrelevant to both provider adapters: the
// OpenAI shape dispatches on frame content, the Anthropic shape on the
// JSON `type` field.

import { ProviderError } from "./types.js";

export interface SseDecoder {
  /** Pushes bytes; yields complete data payloads in order. */
  push(chunk: Uint8Array): string[];
  /** Ends the stream; yields any final pending payload. Throws nothing. */
  end(): string[];
}

export function createSseDecoder(): SseDecoder {
  let buffer = "";
  let dataLines: string[] = [];
  const frames: string[] = [];

  const flush = (): void => {
    if (dataLines.length > 0) {
      frames.push(dataLines.join("\n"));
      dataLines = [];
    }
  };

  const consumeLine = (line: string): void => {
    if (line === "") {
      flush();
      return;
    }
    if (line.startsWith(":")) return; // comment / keep-alive
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    // event:, id:, retry: and unknown fields carry no payload the
    // adapters read.
  };

  return {
    push(chunk: Uint8Array): string[] {
      buffer += new TextDecoder().decode(chunk);
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        consumeLine(line);
      }
      const out = frames.splice(0, frames.length);
      return out;
    },
    end(): string[] {
      if (buffer !== "") {
        consumeLine(buffer.replace(/\r$/, ""));
        buffer = "";
      }
      flush();
      return frames.splice(0, frames.length);
    },
  };
}

/** Wraps a response body into an async iterator of decoded SSE data
 *  payloads; a stalled read (120s idle) or a broken stream fails with the
 *  Rust Stream error text. */
export async function* sseDataStreams(
  res: Response,
  providerLabel: string,
): AsyncIterable<string | ProviderError> {
  const body = res.body;
  if (body === null) {
    yield ProviderError.stream(`${providerLabel} stream ended without a body`);
    return;
  }
  const decoder = createSseDecoder();
  const reader = body.getReader();
  try {
    for (;;) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 120_000)),
      ]);
      if (chunk === "timeout") {
        yield ProviderError.stream("provider did not respond within 120s");
        return;
      }
      if (chunk.done) break;
      for (const frame of decoder.push(chunk.value)) yield frame;
    }
    for (const frame of decoder.end()) yield frame;
  } finally {
    reader.releaseLock();
    // Best-effort cancel so the upstream connection is not left hanging.
    try {
      await body.cancel();
    } catch {
      // already closed
    }
  }
}
