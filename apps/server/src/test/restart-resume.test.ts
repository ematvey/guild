// A suspended runtime leaves committed work pending; a fresh app resumes it.
// SIGKILL recovery is separately covered by worker-mode.test.ts.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { setupM2Stack, type M2Stack } from "./platform/m2-harness.js";

let stack: M2Stack;
let port: number;

beforeAll(async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  stack = await setupM2Stack({
    GUILD_SELF_BASE_URL: `http://127.0.0.1:${port}`,
  });
  await stack.env.app.listen({ port, host: "127.0.0.1" });
  await stack.routeModel("GLM-Test-Model");
});

afterAll(async () => {
  await stack.close();
}, 60_000);

const auth = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

async function waitFor(probe: () => Promise<boolean>, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("waitFor timed out");
}

const sseDelta = (content: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const sseDone = (): string =>
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
  "data: [DONE]\n\n";

describe("restart resume (full durability)", () => {
  it("a turn suspended by runtime close resumes and completes in a fresh app", async () => {
    // A stream slow enough to still be running when the process dies.
    stack.mock.setResponses([
      {
        chunks: [
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
          sseDelta("partial one "),
          sseDelta("partial two "),
          sseDelta("partial three "),
          sseDelta("partial four "),
          sseDelta("partial five "),
          sseDelta("partial six "),
        ],
        chunkDelayMs: 400,
      },
    ]);

    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/chats",
      headers: auth(stack.memberToken),
      payload: { title: "resume chat" },
    });
    const chat = JSON.parse(created.body) as { id: string };

    const sent = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/gateway/chat",
      headers: auth(stack.memberToken),
      payload: {
        chat_id: chat.id,
        model: "GLM-Test-Model",
        messages: [{ role: "user", content: "stream me across a restart" }],
      },
    });
    expect(sent.statusCode).toBe(200);

    // Mid-stream: the model call is running and a partial has committed.
    await waitFor(async () => stack.mock.requests.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 800));

    // Close the actual owner before opening a replacement. Closing only the
    // fixture's seeding pool would leave app1's scheduler and database pool
    // alive, creating two owners rather than simulating a dead process.
    await stack.env.app.platform.runtime.close();
    const pending = await stack.env.db.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM tasks WHERE status<>'terminal'",
    );
    expect(pending.rows[0]!.n).toBeGreaterThan(0);
    stack.env.app.server.closeAllConnections();
    await stack.env.app.close();

    // The next process: the model answers, the run re-drives to completion.
    stack.mock.setResponses([
      {
        body:
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' + sseDelta("resumed answer complete") + sseDone(),
      },
    ]);
    const app2 = await buildApp(stack.env.config);
    await app2.listen({ port, host: "127.0.0.1" });
    try {
      await waitFor(async () => {
        const chatRow = await app2.inject({
          method: "GET",
          url: "/api/v1/chats",
          headers: auth(stack.memberToken),
        });
        const listed = (JSON.parse(chatRow.body) as { chats: { id: string; generating: boolean }[] }).chats.find(
          (c) => c.id === chat.id,
        );
        return listed!.generating === false;
      });

      const thread = await app2.inject({
        method: "GET",
        url: `/api/v1/chats/${chat.id}/thread`,
        headers: auth(stack.memberToken),
      });
      const events = (JSON.parse(thread.body) as { events: { event: Record<string, unknown> }[] }).events;
      const assistant = events.filter((e) => e.event.type === "assistant_message");
      const blocks = (assistant.at(-1)!.event as { blocks: { type: string; text?: string }[] }).blocks;
      const text = blocks.map((b) => b.text ?? "").join("");
      expect(text).toContain("resumed answer complete");
      expect(events.some((e) => e.event.type === "turn_error")).toBe(false);
    } finally {
      await app2.close();
    }
  }, 60_000);
});
