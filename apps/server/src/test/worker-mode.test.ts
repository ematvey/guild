// Worker-per-chat (M2, fork implementation): the server holds no harness;
// each chat's admission runs in its own forked worker over IPC. Gates:
// a turn completes through a forked worker; two chats run in two workers
// and killing one worker mid-turn (SIGKILL) leaves the other streaming and
// the dead one's turn resumed by the respawn.

import { createServer } from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { setupM2Stack, type M2Stack } from "./platform/m2-harness.js";
import { masterKeyBytes, encryptSecret } from "../platform/crypto.js";

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

const toolCallSse = (name: string, args: string): string =>
  'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_wm","type":"function","function":{"name":"' +
  name +
  '","arguments":' +
  JSON.stringify(args) +
  "}}]}}]}\n\n" +
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n' +
  "data: [DONE]\n\n";

const finalSse = (text: string): string =>
  'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
  `data: {"choices":[{"delta":{"content":"${text}"}}]}\n\n` +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n' +
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

  it("a machine-bound chat dispatches its tool through the IPC proxy to the hub", async () => {
    const platformOf = (): import("../platform/context.js").PlatformContext =>
      (stack.env.app as unknown as { platform: import("../platform/context.js").PlatformContext }).platform;

    // The fake daemon speaks the shipped-client executor contract against
    // the PARENT's hub; the worker reaches it only through the proxy.
    const ticket = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/ws/ticket",
      headers: { authorization: `Bearer ${stack.memberToken}` },
    });
    expect(ticket.statusCode).toBe(200);
    const machineId = "worker-dispatch-machine";
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/api/v1/ws?ticket=${(JSON.parse(ticket.body) as { ticket: string }).ticket}` +
        `&machine_id=${machineId}&instance_id=${crypto.randomUUID()}`,
    );
    const openPromise = new Promise<void>((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
    });
    const dispatches: Record<string, unknown>[] = [];
    ws.on("message", (data: Buffer) => {
      const msg = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      if (msg["type"] === "tool_dispatch") {
        dispatches.push(msg);
        ws.send(
          JSON.stringify({
            type: "tool_result",
            chat_id: msg["chat_id"],
            call_id: msg["call_id"],
            content: "Linux workstation 6.1.0",
            is_error: false,
            meta: null,
          }),
        );
      }
    });
    await openPromise;

    await waitFor(async () => {
      const owner = await platformOf().machines.ownerOf(machineId);
      return owner !== null && owner[0] === stack.memberId;
    });
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers: auth(stack.memberToken),
      payload: { title: "worker machine chat" },
    });
    expect(created.statusCode).toBe(200);
    const chatId = (JSON.parse(created.body) as { id: string }).id;
    await platformOf().chats.setMachine(stack.orgId, chatId, machineId, machineId);
    stack.mock.setResponses([{ body: toolCallSse("bash", JSON.stringify({ command: "uname -r" })) }, { body: finalSse("kernel answer") }]);
    const sent = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/threads/${chatId}/turns`,
      headers: auth(stack.memberToken),
      payload: { model: "GLM-Test-Model", messages: [{ role: "user", content: "what kernel is running" }] },
    });
    expect(sent.statusCode).toBe(200);

    await waitFor(async () => dispatches.length > 0, 30_000);
    expect(dispatches[0]!["type"]).toBe("tool_dispatch");
    expect(dispatches[0]!["name"]).toBe("execute");
    await waitFor(async () => {
      const thread = await stack.env.app.inject({
        method: "GET",
        url: `/api/v1/threads/${chatId}`,
        headers: auth(stack.memberToken),
      });
      const events = (JSON.parse(thread.body) as { events: { event: Record<string, unknown> }[] }).events;
      const result = events.find((e) => e.event.type === "tool_result");
      if (!result) return false;
      expect((result.event as { content: string }).content).toBe("Linux workstation 6.1.0");
      return events.some((e) => e.event.type === "assistant_message");
    }, 60_000);
    ws.close();
  }, 120_000);

  it("killing a worker mid-tool-call keeps integration tools on the resumed run", async () => {
    // The vendor answers slowly, so the kill lands while the integration
    // tool call is pending — the resume must re-dispatch it through a
    // freshly provisioned registry, not lose the integration toolset.
    const vendorRequests: string[] = [];
    const vendor = createServer((req, res) => {
      vendorRequests.push(req.url ?? "");
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, channels: [{ id: "C1", name: "general" }] }));
      }, 1_200);
    });
    await new Promise<void>((resolve) => vendor.listen(0, "127.0.0.1", resolve));
    const vendorBase = `http://127.0.0.1:${(vendor.address() as AddressInfo).port}`;

    await stack.env.db.query(
      "INSERT INTO integrations (org_id, name, config, enabled) VALUES ($1, 'slack', $2, true) ON CONFLICT (org_id, name) DO UPDATE SET config = EXCLUDED.config",
      [stack.orgId, JSON.stringify({ base_url: vendorBase, tools: { conversations_list: { enabled: true, approval: "always_allow" } } })],
    );
    const master = masterKeyBytes(stack.env.config.masterKeyHex);
    await stack.env.db.query(
      "INSERT INTO integration_secrets (org_id, integration, name, secret_enc) VALUES ($1, 'slack', 'bot_token', $2) ON CONFLICT (org_id, integration, name) DO NOTHING",
      [stack.orgId, encryptSecret(master, "xoxb-test")],
    );

    const chatId = await createChat("worker kill mid integration call");
    stack.mock.setResponses([
      { body: toolCallSse("slack_conversations_list", JSON.stringify({ limit: 5 })) },
      // The resumed run's own new call: it must resolve through a
      // re-provisioned registry, not die with the interrupted one.
      { body: toolCallSse("slack_conversations_list", JSON.stringify({ limit: 5 })) },
      { body: finalSse("resumed with tools") },
    ]);

    const sent = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/threads/${chatId}/turns`,
      headers: auth(stack.memberToken),
      payload: { model: "GLM-Test-Model", messages: [{ role: "user", content: "list slack channels" }] },
    });
    expect(sent.statusCode).toBe(200);

    // First dispatch through the integration tool — kill while it is in
    // flight (the vendor's 1.2s delay covers the wait).
    await waitFor(async () => vendorRequests.length > 0, 60_000);
    const pid = stack.env.app.platform.supervisor!.pidOf(chatId);
    expect(pid).toBeDefined();
    process.kill(pid!, "SIGKILL");

    // The respawned worker re-drives the run: the interrupted call settles,
    // the model issues a NEW integration call, and that one must resolve —
    // the vendor serves it and its result reaches the thread.
    await waitFor(async () => (await lastAssistant(chatId)).includes("resumed with tools"), 60_000);
    await waitFor(async () => vendorRequests.length >= 2, 30_000);
    const thread = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/threads/${chatId}`,
      headers: auth(stack.memberToken),
    });
    const events = (JSON.parse(thread.body) as { events: { event: Record<string, unknown> }[] }).events;
    const results = events.filter((e) => e.event.type === "tool_result");
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(
      results.some((e) => String((e.event as { content: string }).content).includes("general")),
    ).toBe(true);
    for (const e of results) {
      expect(String((e.event as { content: string }).content)).not.toContain("does not exist");
    }
    vendor.close();
  }, 180_000);
});
