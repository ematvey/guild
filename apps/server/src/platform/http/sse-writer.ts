// SSE reply writer for the gateway streaming endpoints: `data: …\n\n`
// frames, named `event: …\ndata: …\n\n` frames, and a `:\n\n` keep-alive
// comment every 15s of idle.

import type { FastifyReply } from "fastify";

const KEEP_ALIVE_INTERVAL_MS = 15_000;

export function sseReply(reply: FastifyReply, frames: AsyncIterable<string>): void {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });

  let closed = false;
  const onClose = (): void => {
    closed = true;
  };
  // Response 'close' fires on premature client disconnects (and after a
  // normal end, when the generator has already settled — harmless).
  raw.on("close", onClose);

  const write = (text: string): void => {
    if (!closed && !raw.writableEnded) raw.write(text);
  };

  void pump();

  async function pump(): Promise<void> {
    let keepAlive: NodeJS.Timeout | null = setInterval(() => write(":\n\n"), KEEP_ALIVE_INTERVAL_MS);
    try {
      for await (const frame of frames) {
        if (closed) return;
        // The generator yields complete SSE frames (OpenAI data chunks and
        // Anthropic named events both end with a blank line).
        write(frame);
      }
    } catch {
      // The generator surfaced its error frames itself; transport-level
      // failures just end the stream.
    } finally {
      if (keepAlive !== null) clearInterval(keepAlive);
      keepAlive = null;
      raw.off("close", onClose);
      if (!closed) {
        try {
          raw.end();
        } catch {
          // already torn down by a client disconnect
        }
      }
    }
  }
}


/** A data-only SSE frame (OpenAI chunks). */
export function sseDataFrame(data: string): string {
  return `data: ${data}\n\n`;
}
