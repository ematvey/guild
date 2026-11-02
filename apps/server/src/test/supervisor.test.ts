// M0 supervisor: a durable session failure must be healed in-process by
// the reopen loop (pi-durable's documented recovery: reopen + resume), not
// wedge the server until a redeploy. A sealed session takes no writes, so
// the in-flight turn stays pending and resume re-drives it to completion.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { armDurableFault } from "../storage/postgres/pg.js";
import { setupM2Stack, type M2Stack } from "./platform/m2-harness.js";
import { waitFor } from "./support/wait.js";

let stack: M2Stack;
let port: number;

beforeAll(async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error === undefined ? resolve() : reject(error))));
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

const sseDelta = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const sseDone = (): string =>
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
  "data: [DONE]\n\n";

async function assistantText(chatId: string): Promise<string> {
  const thread = await stack.env.app.inject({
    method: "GET",
    url: `/api/v1/chats/${chatId}/thread`,
    headers: auth(stack.memberToken),
  });
  const events = (JSON.parse(thread.body) as { events: { event: Record<string, unknown> }[] }).events;
  const assistant = events.filter((e) => e.event.type === "assistant_message");
  const blocks = (assistant.at(-1)!.event as { blocks: { type: string; text?: string }[] }).blocks;
  return blocks.map((b) => b.text ?? "").join("");
}

describe("supervisor reopen (M0)", () => {
  it("a storage fault mid-turn reopens the session and the turn completes", async () => {
    // A stream slow enough to still be running when the session fails.
    stack.mock.setResponses([
      {
        chunks: [
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
          sseDelta("partial one "),
          sseDelta("partial two "),
          sseDelta("partial three "),
          sseDelta("partial four "),
          sseDelta("partial five "),
        ],
        chunkDelayMs: 400,
      },
    ]);

    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/chats",
      headers: auth(stack.memberToken),
      payload: { title: "supervisor chat" },
    });
    const chat = JSON.parse(created.body) as { id: string };

    const sent = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/gateway/chat",
      headers: auth(stack.memberToken),
      payload: {
        chat_id: chat.id,
        model: "GLM-Test-Model",
        messages: [{ role: "user", content: "stream me across a session failure" }],
      },
    });
    expect(sent.statusCode).toBe(200);

    // Mid-stream: the model call is running and a partial has committed.
    await waitFor(async () => stack.mock.requests.length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 800));

    // One failed durable operation seals the session (fail-stop): the
    // supervisor must reopen and resume, and the turn must finish — the
    // same behavior the poisoned-document incident turned into a full
    // outage before the supervisor existed.
    armDurableFault(() => new Error("synthetic durable fault"));

    stack.mock.setResponses([
      {
        body:
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
          sseDelta("recovered once") +
          sseDone(),
      },
    ]);
    await waitFor(async () => {
      if (stack.mock.requests.length < 2) return false;
      return (await assistantText(chat.id)).includes("recovered once");
    });

    const thread = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/chats/${chat.id}/thread`,
      headers: auth(stack.memberToken),
    });
    const events = (JSON.parse(thread.body) as { events: { event: Record<string, unknown> }[] }).events;
    // The recovery path surfaces a turn error only if the run failed for
    // real; a supervisor reopen must not end the turn in error.
    expect(events.some((e) => e.event.type === "turn_error")).toBe(false);

    // A second fault right after recovery, again mid-turn: the backoff
    // ladder's second step, same outcome.
    stack.mock.setResponses([
      {
        chunks: [
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
          sseDelta("second partial one "),
          sseDelta("second partial two "),
        ],
        chunkDelayMs: 400,
      },
      {
        body:
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
          sseDelta("recovered twice") +
          sseDone(),
      },
      {
        body:
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
          sseDelta("keep-alive after two reopen cycles") +
          sseDone(),
      },
    ]);
    const sent2 = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/gateway/chat",
      headers: auth(stack.memberToken),
      payload: {
        chat_id: chat.id,
        model: "GLM-Test-Model",
        messages: [{ role: "user", content: "stream me across a second failure" }],
      },
    });
    expect(sent2.statusCode).toBe(200);
    // Turn 2's model call is the third request; a partial has committed.
    await waitFor(async () => stack.mock.requests.length >= 3);
    await new Promise((resolve) => setTimeout(resolve, 800));
    armDurableFault(() => new Error("synthetic durable fault 2"));
    await waitFor(async () => {
      if (stack.mock.requests.length < 4) return false;
      return (await assistantText(chat.id)).includes("recovered twice");
    });

    // The server still serves after two reopens: a fresh turn completes.
    const sent3 = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/gateway/chat",
      headers: auth(stack.memberToken),
      payload: {
        chat_id: chat.id,
        model: "GLM-Test-Model",
        messages: [{ role: "user", content: "one more after two reopen cycles" }],
      },
    });
    expect(sent3.statusCode).toBe(200);
    await waitFor(async () => (await assistantText(chat.id)).includes("keep-alive"));
    const listedOf = async () => {
      const chatList = await stack.env.app.inject({
        method: "GET",
        url: "/api/v1/chats",
        headers: auth(stack.memberToken),
      });
      return (JSON.parse(chatList.body) as { chats: { id: string; generating: boolean }[] }).chats
        .find((c) => c.id === chat.id);
    };
    // The answer is committed before the run lifecycle clears `generating`,
    // so poll for the settled row rather than reading once.
    await waitFor(async () => (await listedOf())?.generating === false);
    expect((await listedOf())!.generating).toBe(false);
  }, 120_000);
});
