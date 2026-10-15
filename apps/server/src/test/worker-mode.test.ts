// Worker-per-chat (M2, fork implementation): the server holds no harness;
// each chat's admission runs in its own forked worker over IPC. Gates:
// a turn completes through a forked worker; two chats run in two workers
// and killing one worker mid-turn (SIGKILL) leaves the other streaming and
// the dead one's turn resumed by the respawn.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupM2Stack, type M2Stack } from "./platform/m2-harness.js";

let stack: M2Stack;
let port: number;

beforeAll(async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error === undefined ? resolve() : reject(error))));
  stack = await setupM2Stack({
    GUILD_SELF_BASE_URL: `http://127.0.0.1:${port}`,
    GUILD_WORKER_MODE: "on",
  });
  await stack.env.app.listen({ port, host: "127.0.0.1" });
  await stack.routeModel("GLM-Test-Model");
});

afterAll(async () => {
  await stack.close();
}, 90_000);

const auth = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

async function waitFor(probe: () => Promise<boolean>, timeoutMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("waitFor timed out");
}

const sseDelta = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const sseDone = (): string =>
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
  "data: [DONE]\n\n";

async function submit(chatId: string, content: string): Promise<void> {
  const sent = await stack.env.app.inject({
    method: "POST",
    url: "/api/v1/gateway/chat",
    headers: auth(stack.memberToken),
    payload: { chat_id: chatId, model: "GLM-Test-Model", messages: [{ role: "user", content }] },
  });
  expect(sent.statusCode).toBe(200);
}

async function lastAssistant(chatId: string): Promise<string> {
  const thread = await stack.env.app.inject({
    method: "GET",
    url: `/api/v1/chats/${chatId}/thread`,
    headers: auth(stack.memberToken),
  });
  const events = (JSON.parse(thread.body) as { events: { event: Record<string, unknown> }[] }).events;
  const assistant = events.filter((e) => e.event.type === "assistant_message");
  if (assistant.length === 0) return "";
  const blocks = (assistant.at(-1)!.event as { blocks: { type: string; text?: string }[] }).blocks;
  return blocks.map((b) => b.text ?? "").join("");
}

async function createChat(title: string): Promise<string> {
  const created = await stack.env.app.inject({
    method: "POST",
    url: "/api/v1/chats",
    headers: auth(stack.memberToken),
    payload: { title },
  });
  return (JSON.parse(created.body) as { id: string }).id;
}

describe("worker-per-chat (fork supervisor)", () => {
  it("admits and completes a turn through a forked worker", async () => {
    const chatId = await createChat("worker mode chat");
    stack.mock.setResponses([
      {
        body:
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
          sseDelta("worker mode answer") +
          sseDone(),
      },
    ]);
    await submit(chatId, "hello through a forked worker");
    await waitFor(async () => (await lastAssistant(chatId)).includes("worker mode answer"));
    const chatList = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/chats",
      headers: auth(stack.memberToken),
    });
    const listed = (JSON.parse(chatList.body) as { chats: { id: string; generating: boolean }[] }).chats
      .find((c) => c.id === chatId);
    expect(listed!.generating).toBe(false);
    expect(stack.env.app.platform.supervisor!.pidOf(chatId)).toBeDefined();
  }, 90_000);

  it("killing one chat's worker mid-turn leaves the other chat alone and the turn resumes", async () => {
    const chatA = await createChat("worker kill A");
    const chatB = await createChat("worker kill B");
    const slowChunks = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      sseDelta("slow a1 "), sseDelta("slow a2 "), sseDelta("slow a3 "),
      sseDelta("slow a4 "), sseDelta("slow a5 "), sseDelta("slow a6 "),
      sseDelta("slow a7 "), sseDelta("slow a8 "),
      sseDone(),
    ];
    stack.mock.setResponses([
      { chunks: slowChunks, chunkDelayMs: 400 },
      { chunks: slowChunks.map((c) => c.replace("slow", "bee")), chunkDelayMs: 400 },
      { body: 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' + sseDelta("resumed after kill") + sseDone() },
    ]);

    await submit(chatA, "stream in worker A");
    await submit(chatB, "stream in worker B");
    await waitFor(async () => stack.mock.requests.length >= 2);
    await new Promise((resolve) => setTimeout(resolve, 900)); // partials commit

    const pidA = stack.env.app.platform.supervisor!.pidOf(chatA);
    expect(pidA).toBeDefined();
    process.kill(pidA!, "SIGKILL");

    // B must finish undisturbed; A's worker respawns and re-drives its turn.
    await waitFor(async () => (await lastAssistant(chatB)).includes("bee"));
    await waitFor(async () => (await lastAssistant(chatA)).includes("resumed after kill"));
    const chatList = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/chats",
      headers: auth(stack.memberToken),
    });
    const listed = (JSON.parse(chatList.body) as { chats: { id: string; generating: boolean }[] }).chats;
    expect(listed.find((c) => c.id === chatA)!.generating).toBe(false);
    expect(listed.find((c) => c.id === chatB)!.generating).toBe(false);
    const threadA = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/chats/${chatA}/thread`,
      headers: auth(stack.memberToken),
    });
    const eventsA = (JSON.parse(threadA.body) as { events: { event: Record<string, unknown> }[] }).events;
    expect(eventsA.some((e) => e.event.type === "turn_error")).toBe(false);
  }, 120_000);
});
