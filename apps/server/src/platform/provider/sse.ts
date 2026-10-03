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

/** Formats a parsed JSON value the way serde_json renders a Value (BTreeMap
 *  key order) — used wherever parsed provider values are re-encoded. */
export function serializeRustJson(value: unknown): string {
  return rustJsonText(value);
}

export interface RustFloat {
  readonly __rustFloat: number;
}

/** Marks a value that must serialize as an f64 (ryu rules: integral floats
 *  keep a ".0" tail) even when it holds an integral number — serde's
 *  integer fields render plain, floats never lose their ".0". */
export function rustFloat(n: number): RustFloat {
  return { __rustFloat: n };
}

export function rustJsonText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    // Integers render plain; fractions get their shortest form.
    return Number.isInteger(value) ? String(value) : String(value).replace("e+", "e");
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object" && "__rustFloat" in value) {
    return rustFloatText((value as RustFloat).__rustFloat);
  }
  if (Array.isArray(value)) return `[${value.map(rustJsonText).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${rustJsonText((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** serde_json's ryu rendering for f64 values. */
export function rustFloatText(n: number): string {
  if (!Number.isFinite(n)) return "null"; // serde_json: non-finite → null
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return `${n.toFixed(1)}`;
  return String(n).replace("e+", "e");
}


