// The core turn flow under both turn placements: in-process (the server
// holds the harness) and workers (each chat's turns run in a forked worker,
// GUILD_WORKER_MODE=on — the dev stack's mode). A turn is admitted and
// answered, a follow-up turn runs after it, and stopping an idle chat
// settles it, with the same observable results in both.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupM2Stack, type M2Stack } from "./platform/m2-harness.js";
import { waitFor } from "./support/wait.js";

const MODEL = "Mode-Test-Model";

const sseDelta = (content: string): string => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const sseDone = (): string =>
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
  "data: [DONE]\n\n";
const answer = (text: string) => ({
  body: 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' + sseDelta(text) + sseDone(),
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error === undefined ? resolve() : reject(error))));
  return port;
}

describe.each([
  { mode: "off" as const, label: "in-process" },
  { mode: "on" as const, label: "workers" },
])("turn flow ($label)", ({ mode }) => {
  let stack: M2Stack;

  beforeAll(async () => {
    const port = await freePort();
    stack = await setupM2Stack({ GUILD_SELF_BASE_URL: `http://127.0.0.1:${port}`, GUILD_WORKER_MODE: mode });
    await stack.env.app.listen({ port, host: "127.0.0.1" });
    await stack.routeModel(MODEL);
  });

  afterAll(async () => {
    await stack?.close();
  }, 90_000);

  const headers = (): Record<string, string> => ({
    authorization: `Bearer ${stack.memberToken}`,
    "content-type": "application/json",
  });

  /** A titled chat: a fresh untitled thread spends a model call on its
   *  name, which would take a scripted answer. */
  async function createChat(): Promise<string> {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/chats",
      headers: headers(),
      payload: { title: "turn modes" },
    });
    expect(created.statusCode).toBe(200);
    return (JSON.parse(created.body) as { id: string }).id;
  }

  async function submit(chatId: string, content: string): Promise<void> {
    const sent = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/threads/${chatId}/turns`,
      headers: headers(),
      payload: { model: MODEL, messages: [{ role: "user", content }] },
    });
    expect(sent.statusCode).toBe(200);
  }

  async function assistantTexts(chatId: string): Promise<string[]> {
    const thread = await stack.env.app.inject({ method: "GET", url: `/api/v1/chats/${chatId}/thread`, headers: headers() });
    const events = (JSON.parse(thread.body) as { events: { event: Record<string, unknown> }[] }).events;
    return events
      .filter((e) => e.event.type === "assistant_message")
      .map((e) => ((e.event as { blocks: { text?: string }[] }).blocks ?? []).map((b) => b.text ?? "").join(""));
  }

  async function generating(chatId: string): Promise<boolean | undefined> {
    const list = await stack.env.app.inject({ method: "GET", url: "/api/v1/chats", headers: headers() });
    return (JSON.parse(list.body) as { chats: { id: string; generating: boolean }[] }).chats.find((c) => c.id === chatId)
      ?.generating;
  }

  it("answers a turn and settles the chat", async () => {
    const chatId = await createChat();
    stack.mock.setResponses([answer("first answer")]);
    await submit(chatId, "first question");
    await waitFor(async () => (await assistantTexts(chatId)).includes("first answer"));
    await waitFor(async () => (await generating(chatId)) === false);
    expect(stack.env.app.platform.supervisor === undefined).toBe(mode === "off");
  }, 90_000);

  it("runs a follow-up turn after the first", async () => {
    const chatId = await createChat();
    stack.mock.setResponses([answer("one"), answer("two")]);
    await submit(chatId, "first");
    await waitFor(async () => (await assistantTexts(chatId)).includes("one"));
    await waitFor(async () => (await generating(chatId)) === false);
    await submit(chatId, "second");
    await waitFor(async () => (await assistantTexts(chatId)).includes("two"));
    expect(await assistantTexts(chatId)).toEqual(["one", "two"]);
  }, 90_000);

  it("stops an idle chat without error", async () => {
    const chatId = await createChat();
    stack.mock.setResponses([answer("done")]);
    await submit(chatId, "then stop");
    await waitFor(async () => (await generating(chatId)) === false);
    await stack.env.app.platform.runtime.stopChat(chatId);
    expect(await generating(chatId)).toBe(false);
  }, 90_000);
});
