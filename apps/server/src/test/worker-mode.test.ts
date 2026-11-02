// Worker-per-chat: the server holds no harness; each chat's admission runs
// in its own forked worker over IPC. A turn completes through a forked
// worker; two chats run in two workers and killing one worker mid-turn
// (SIGKILL) leaves the other streaming and the dead one's turn resumed by
// the respawn.

import { createServer } from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { StreamWireEvent, WsServerMsg } from "../hub/protocol.js";
import { setupGatewayStack, type GatewayStack } from "./support/gateway-stack.js";
import { createSession, InboxDoc, AssistantEntry, UserEntry, type ConversationId } from "@earendil-works/pi-durable";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { PostgresDurableStorage } from "../storage/postgres/index.js";
import { PgPoolDatabase } from "../storage/postgres/pg.js";
import { masterKeyBytes, encryptSecret } from "../platform/crypto.js";
import { waitFor } from "./support/wait.js";

let stack: GatewayStack;
let port: number;

beforeAll(async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error === undefined ? resolve() : reject(error))));
  stack = await setupGatewayStack({
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

const sseDelta = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const sseDone = (): string =>
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
  "data: [DONE]\n\n";

const toolCallSse = (name: string, args: string): string =>
  'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_wm","type":"function","function":{"name":"codemode","arguments":' +
  JSON.stringify(JSON.stringify({ code: `return await tools.${name}(${args});` })) +
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
  it("relays partials before completion and restores them on socket sync", async () => {
    const chatId = await createChat("worker streaming relay");
    const ticket = await stack.env.app.inject({ method: "POST", url: "/api/v1/ws/ticket", headers: auth(stack.memberToken), payload: {} });
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?ticket=${JSON.parse(ticket.body).ticket}&instance_id=${crypto.randomUUID()}`);
    const frames: (Exclude<WsServerMsg, { type: "live_frame" }> | { type: "live_frame"; chat_id: string; generation_id: string; event: StreamWireEvent })[] = [];
    ws.on("message", data => frames.push(JSON.parse(data.toString())));
    try {
      await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
      stack.mock.setResponses([{ chunks: [sseDelta("partial-before-terminal"), sseDelta(" final"), sseDone()], chunkDelayMs: 800 }]);
      const response = await stack.env.app.inject({ method: "POST", url: `/api/v1/threads/${chatId}/turns`, headers: auth(stack.memberToken), payload: { model: "GLM-Test-Model", messages: [{ role: "user", content: "stream before settling" }] } });
      expect(response.statusCode).toBe(200);
      const commandId = JSON.parse(response.body).generation_id;
      await waitFor(async () => frames.some(f => f.type === "live_frame" && f.chat_id === chatId && f.event?.type === "delta" && f.event.content.includes("partial-before-terminal")));
      expect(await lastAssistant(chatId)).toBe("");
      expect(stack.env.app.platform.runtime.liveBuffers(chatId).text).toBe("partial-before-terminal");
      const delta = frames.filter(f => f.type === "live_frame").find(f => f.event.type === "delta")!;
      expect(delta.generation_id).toBe(commandId);
      frames.length = 0;
      ws.send(JSON.stringify({ type: "sync", chat_id: chatId }));
      await waitFor(async () => frames.some(f => f.type === "thread_state" && f.chat_id === chatId && f.text === "partial-before-terminal" && f.generating));
      await waitFor(async () => (await lastAssistant(chatId)) === "partial-before-terminal final");
      await waitFor(async () => frames.some(f => f.type === "live_frame" && f.event?.type === "done"));
      expect(stack.env.app.platform.runtime.liveBuffers(chatId)).toEqual({ text: "", thinking: "" });
    } finally {
      ws.close();
    }
  }, 60_000);

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
    const listedOf = async () => {
      const chatList = await stack.env.app.inject({
        method: "GET",
        url: "/api/v1/chats",
        headers: auth(stack.memberToken),
      });
      return (JSON.parse(chatList.body) as { chats: { id: string; generating: boolean }[] }).chats
        .find((c) => c.id === chatId);
    };
    // The answer is committed before the run lifecycle clears `generating`,
    // so poll for the settled row rather than reading once.
    await waitFor(async () => (await listedOf())?.generating === false);
    expect((await listedOf())!.generating).toBe(false);
    expect(stack.env.app.platform.supervisor!.pidOf(chatId)).toBeDefined();
  }, 90_000);

  it("delivers a child steer into the chat's own worker", async () => {
    const chatId = await createChat("child steer chat");
    stack.mock.setResponses([
      { body: 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' + sseDelta("first answer") + sseDone() },
    ]);
    await submit(chatId, "start");
    await waitFor(async () => (await lastAssistant(chatId)).includes("first answer"));

    stack.mock.setResponses([
      { body: 'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' + sseDelta("steered answer") + sseDone() },
    ]);
    await stack.env.app.platform.runtime.deliverChildSteer(chatId, stack.orgId, "a child reported back", null);
    await waitFor(async () => (await lastAssistant(chatId)).includes("steered answer"));
  }, 90_000);

  it("rebuilds a poisoned projection on worker restart and completes the next turn", async () => {
    const chatId = await createChat("recover live projection");
    stack.mock.setResponses([{ body: finalSse("before projection repair") }]);
    await submit(chatId, "first turn");
    await waitFor(async () => (await lastAssistant(chatId)).includes("before projection repair"));
    const mapping = await stack.env.db.query<{ conversation_id: string }>("SELECT conversation_id FROM chat_conversations WHERE chat_id=$1", [chatId]);
    const conversationId = mapping.rows[0]!.conversation_id;
    const docs = await stack.env.db.query<{ id: string }>("SELECT id FROM documents WHERE kind=$1 AND owner_id=$2 AND retired_at IS NULL", [JSON.stringify("pi.live"), conversationId]);
    const documentId = docs.rows[0]!.id;
    process.kill(stack.env.app.platform.supervisor!.pidOf(chatId)!, "SIGKILL");
    await waitFor(async () => stack.env.app.platform.supervisor!.pidOf(chatId) === undefined);
    await stack.env.db.query(`WITH reserved AS (UPDATE durable_metadata SET next_seq=next_seq+1 WHERE singleton=1 RETURNING next_seq-1 AS seq)
      INSERT INTO document_revisions(document_id,seq,kind,version,content) SELECT $1,seq,'delta',1,$2 FROM reserved`, [documentId, JSON.stringify([["s", ["nestedTools", 0, "output"], "late output"]])]);
    stack.mock.setResponses([{ body: finalSse("after projection repair") }]);
    await submit(chatId, "second turn");
    await waitFor(async () => (await lastAssistant(chatId)).includes("after projection repair"));
    const repairs = await stack.env.db.query("SELECT document_id FROM live_projection_repairs WHERE document_id=$1", [documentId]);
    expect(repairs.rows).toHaveLength(1);
    const inputs = await stack.env.db.query<{ status: string }>("SELECT status FROM submissions WHERE conversation_id=$1 AND record::jsonb->>'type'='input' ORDER BY id", [conversationId]);
    expect(inputs.rows.map(row => row.status)).toEqual(["done", "done"]);
    const thread = await stack.env.app.inject({ method: "GET", url: `/api/v1/chats/${chatId}/thread`, headers: auth(stack.memberToken) });
    expect(thread.body).toContain("before projection repair");
    expect(thread.body).toContain("after projection repair");
  }, 90_000);

  it("respawns for a missing transcript projection after every agent task has settled", async () => {
    const chatId = await createChat("recover committed answer");
    stack.mock.setResponses([{ body: finalSse("first answer") }]);
    await submit(chatId, "first input");
    await waitFor(async () => (await lastAssistant(chatId)).includes("first answer"));
    const conversationId = Number((await stack.env.db.query("SELECT conversation_id FROM chat_conversations WHERE chat_id=$1", [chatId])).rows[0].conversation_id) as ConversationId;
    await waitFor(async () => (await stack.env.db.query(`SELECT NOT EXISTS(SELECT 1 FROM entries e WHERE e.conversation_id=$1
      AND e.id>COALESCE((SELECT p.entry_id FROM chat_projection_cursors p WHERE p.chat_id=$2),0)) AS ready`, [conversationId,chatId])).rows[0].ready);
    const database = new PgPoolDatabase(stack.env.db);
    database.close = async () => {};
    const session = createSession(await PostgresDurableStorage.open(database));
    try {
      await session.commit(async tx => {
        await tx.appendEntry(UserEntry, conversationId, { model: [{ role: "user", content: "committed input", timestamp: Date.now() }] });
        await tx.appendEntry(AssistantEntry, conversationId, { model: [fauxAssistantMessage("committed before bridge crash")] });
      }, BACKGROUND_CONTEXT);
    } finally { await session.close(BACKGROUND_CONTEXT); }
    expect((await stack.env.db.query("SELECT count(*)::int AS n FROM tasks WHERE conversation_id=$1 AND status<>'terminal'", [conversationId])).rows[0].n).toBe(0);
    process.kill(stack.env.app.platform.supervisor!.pidOf(chatId)!, "SIGKILL");
    await waitFor(async () => (await lastAssistant(chatId)).includes("committed before bridge crash"));
    const thread = await stack.env.app.inject({ method: "GET", url: `/api/v1/chats/${chatId}/thread`, headers: auth(stack.memberToken) });
    expect(thread.body.match(/committed before bridge crash/g)).toHaveLength(1);
  }, 30_000);

  it("startup drains an idle durable queue without requiring another user message", async () => {
    const chatId = await createChat("resume queued input");
    stack.mock.setResponses([{ body: finalSse("first answer") }]);
    await submit(chatId, "first input");
    await waitFor(async () => (await lastAssistant(chatId)).includes("first answer"));
    const mapping = await stack.env.db.query<{ conversation_id: string }>("SELECT conversation_id FROM chat_conversations WHERE chat_id=$1", [chatId]);
    const conversationId = Number(mapping.rows[0]!.conversation_id) as ConversationId;
    process.kill(stack.env.app.platform.supervisor!.pidOf(chatId)!, "SIGKILL");
    await waitFor(async () => stack.env.app.platform.supervisor!.pidOf(chatId) === undefined);
    // A Session writes the exact durable idle+queued state; it owns no scheduler.
    const database = new PgPoolDatabase(stack.env.db);
    database.close = async () => {}; // The test stack owns the shared pool.
    const session = createSession(await PostgresDurableStorage.open(database));
    const queuedId = await session.commit(async tx => {
      const inbox = await tx.doc(InboxDoc, conversationId);
      const item = await tx.createSubmission({ conversationId, type: "input", status: "queued", requestId: "parked-input" });
      inbox.items.push({ id: item.id, mode: "followUp", content: "queued before restart" });
      return item.id;
    }, BACKGROUND_CONTEXT);
    await session.close(BACKGROUND_CONTEXT);
    await stack.env.db.query("UPDATE chats SET generating=true WHERE id=$1", [chatId]);
    stack.mock.setResponses([{ body: finalSse("recovered queued answer") }]);
    await stack.env.app.platform.supervisor!.recoverFromJournal([{ chatId }]);
    await waitFor(async () => (await lastAssistant(chatId)).includes("recovered queued answer"));
    const record = await stack.env.db.query<{ status: string }>("SELECT status FROM submissions WHERE id=$1", [queuedId]);
    expect(record.rows[0]!.status).toBe("done");
    await waitFor(async () => !(await stack.env.db.query<{ generating: boolean }>("SELECT generating FROM chats WHERE id=$1", [chatId])).rows[0]!.generating);
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
    const listedOf = async () => {
      const chatList = await stack.env.app.inject({
        method: "GET",
        url: "/api/v1/chats",
        headers: auth(stack.memberToken),
      });
      return (JSON.parse(chatList.body) as { chats: { id: string; generating: boolean }[] }).chats;
    };
    // The answer is committed before the run lifecycle clears `generating`,
    // so poll for the settled rows rather than reading once.
    await waitFor(async () => {
      const listed = await listedOf();
      return listed.find((c) => c.id === chatA)?.generating === false && listed.find((c) => c.id === chatB)?.generating === false;
    });
    const listed = await listedOf();
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
    const platformOf = (): import("../composition.js").PlatformContext =>
      (stack.env.app as unknown as { platform: import("../composition.js").PlatformContext }).platform;

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
      // The codemode card carries the nested execute's structured output.
      expect((result.event as { content: string }).content).toContain("Linux workstation 6.1.0");
      return events.some((e) => e.event.type === "assistant_message");
    }, 60_000);
    ws.close();
  }, 120_000);

  it("stopping a machine tool crosses worker IPC and cancels the accepting executor", async () => {
    const ticket = await stack.env.app.inject({ method: "POST", url: "/api/v1/ws/ticket", headers: { authorization: `Bearer ${stack.memberToken}` } });
    expect(ticket.statusCode).toBe(200);
    const machineId = "worker-cancel-machine";
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/v1/ws?ticket=${JSON.parse(ticket.body).ticket}&machine_id=${machineId}&instance_id=${crypto.randomUUID()}`);
    const frames: Record<string, unknown>[] = [];
    ws.on("message", (data: Buffer) => frames.push(JSON.parse(data.toString("utf8"))));
    await new Promise<void>((resolve, reject) => { ws.on("open", resolve); ws.on("error", reject); });
    try {
      await waitFor(async () => stack.env.app.platform.hub.machineOnline(machineId));
      const chatId = await createChat("cancel machine tool");
      await stack.env.db.query("UPDATE chats SET approval=$2 WHERE id=$1", [chatId, JSON.stringify({ default: "full_access" })]);
      await stack.env.app.platform.chats.setMachine(stack.orgId, chatId, machineId, machineId);
      stack.mock.setResponses([{ body: toolCallSse("bash", JSON.stringify({ command: "sleep 30" })) }, { body: finalSse("stopped") }]);
      await submit(chatId, "start long command");
      await waitFor(async () => frames.some(frame => frame.type === "tool_dispatch"));
      const dispatch = frames.find(frame => frame.type === "tool_dispatch")!;
      const stopped = await stack.env.app.inject({ method: "POST", url: `/api/v1/threads/${chatId}/stop`, headers: { authorization: `Bearer ${stack.memberToken}` } });
      expect(stopped.statusCode).toBe(200);
      await waitFor(async () => frames.some(frame => frame.type === "tool_cancel"));
      expect(frames.find(frame => frame.type === "tool_cancel")!.call_id).toBe(dispatch.call_id);
      ws.send(JSON.stringify({ type: "tool_result", chat_id: chatId, call_id: dispatch.call_id, content: "late result must be ignored", is_error: false, meta: null }));
      await waitFor(async () => {
        const row = await stack.env.db.query<{ generating: boolean }>("SELECT generating FROM chats WHERE id=$1", [chatId]);
        return row.rows[0]!.generating === false;
      });
      const thread = await stack.env.app.inject({ method: "GET", url: `/api/v1/threads/${chatId}`, headers: auth(stack.memberToken) });
      expect(thread.body).not.toContain("late result must be ignored");
    } finally { ws.close(); }
  }, 90_000);

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
