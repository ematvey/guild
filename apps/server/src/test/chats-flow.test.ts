// M3 chats/turns flow against the real app + harness + mock provider: the
// chat CRUD wire, the gateway/chat turn path (pi-durable → bridge →
// thread_events), the SSE thread-stream endpoint, stop/compact/approval
// routes, and the gateway metering of harness calls (internal key over
// loopback).

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The turn flow waits on async bridge/compaction writes: generous timeouts.
const TEST_TIMEOUT = 30_000;

const sseDelta = (content: string): string =>
  `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;
const sseDone = (): string =>
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
  "data: [DONE]\n\n";
import { setupM2Stack, type M2Stack } from "./platform/m2-harness.js";
import type { PlatformContext } from "../platform/context.js";

let stack: M2Stack;
let port: number;

beforeAll(async () => {
  // Pre-allocate the loopback port the harness's selfBaseUrl needs (the
  // runtime calls the app's own /openai/v1 over TCP).
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
}, 30_000);

const auth = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

/** Waits until `probe` returns true (bridge/compaction writes are async). */
async function waitFor(probe: () => Promise<boolean>, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("waitFor timed out");
}

describe("chats CRUD wire", () => {
  it("creates + lists + archives chats in the Rust wire shape", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/chats",
      headers: auth(stack.memberToken),
      payload: { title: "flow chat" },
    });
    expect(created.statusCode).toBe(200);
    const chat = JSON.parse(created.body) as Record<string, unknown>;
    // Live-captured Rust wire order (see fixtures/m3-live/chat.json):
    // id, org_id, user_id, title, created_at, generating, unread, machine_online.
    expect(Object.keys(chat)).toEqual([
      "id",
      "org_id",
      "user_id",
      "title",
      "created_at",
      "generating",
      "unread",
      "machine_online",
    ]);
    expect(chat.machine_online).toBe(false);
    expect(chat.generating).toBe(false);
    expect(chat.unread).toBe(false);

    const list = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/chats",
      headers: auth(stack.memberToken),
    });
    expect(list.statusCode).toBe(200);
    const chats = JSON.parse(list.body) as { chats: Record<string, unknown>[] };
    expect(chats.chats.some((c) => c.id === chat.id)).toBe(true);

    const archived = await stack.env.app.inject({
      method: "PATCH",
      url: `/api/v1/chats/${chat.id as string}`,
      headers: auth(stack.memberToken),
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);
    const archiveList = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/chats?archived=true",
      headers: auth(stack.memberToken),
    });
    const archivedChats = JSON.parse(archiveList.body) as { chats: { id: string }[] };
    expect(archivedChats.chats.some((c) => c.id === chat.id)).toBe(true);
    const activeList = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/chats",
      headers: auth(stack.memberToken),
    });
    expect((JSON.parse(activeList.body) as { chats: { id: string }[] }).chats.some((c) => c.id === chat.id)).toBe(false);
  });

  it("orders the sidebar list by recent activity, not creation", async () => {
    const app = stack.env.app.inject;
    const created = async (title: string) =>
      JSON.parse(
        (await app({
          method: "POST",
          url: "/api/v1/chats",
          headers: auth(stack.memberToken),
          payload: { title },
        })).body,
      ) as { id: string };
    // B is created after A — creation order alone would keep B on top.
    const a = await created("older chat, live turn");
    const b = await created("newer chat, never used");
    const platform = (stack.env.app as unknown as { platform: PlatformContext }).platform;
    await platform.threads.appendEvent(a.id, { type: "user_message", content: "hello", attachments: [] });

    const list = JSON.parse(
      (await app({ method: "GET", url: "/api/v1/chats", headers: auth(stack.memberToken) })).body,
    ) as { chats: { id: string; created_at: string; last_activity_at: string }[] };
    const rows = list.chats.filter((c) => c.id === a.id || c.id === b.id);
    expect(rows.map((r) => r.id)).toEqual([a.id, b.id]);
    // Every list row carries the activity stamp; the never-used chat falls
    // back to its creation time, the active one to its latest event.
    expect(rows[1]!.last_activity_at).toBe(rows[1]!.created_at);
    expect(Date.parse(rows[0]!.last_activity_at)).toBeGreaterThan(Date.parse(rows[1]!.last_activity_at));
  });

  it("mark-read + approval routes answer in the settled shape", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/chats",
      headers: auth(stack.memberToken),
      payload: {},
    });
    const chat = JSON.parse(created.body) as { id: string };
    const read = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/chats/${chat.id}/read`,
      headers: auth(stack.memberToken),
      payload: {},
    });
    expect(read.statusCode).toBe(200);

    const approval = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/gateway/chat/${chat.id}/approvals/call-xyz`,
      headers: auth(stack.memberToken),
      payload: { approved: true },
    });
    expect(approval.statusCode).toBe(200);
    const body = JSON.parse(approval.body) as Record<string, unknown>;
    // Orphaned call → expired journal (M4 forwards live decisions).
    expect(body).toEqual({ ok: true, settled: true, approved: false, reason: expect.any(String), expired: true });

    // The decision event landed in the thread log.
    const thread = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/chats/${chat.id}/thread`,
      headers: auth(stack.memberToken),
    });    const events = (JSON.parse(thread.body) as { events: { event: { type: string } }[] }).events;
    expect(events.some((e) => e.event.type === "approval_decision")).toBe(true);
  });

  it("stores tool output containing NUL characters (jsonb has no U+0000)", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/chats",
      headers: auth(stack.memberToken),
      payload: {},
    });
    const chat = JSON.parse(created.body) as { id: string };
    const platform = (stack.env.app as unknown as { platform: PlatformContext }).platform;
    const row = await platform.threads.appendEvent(chat.id, {
      type: "tool_result",
      turn: 1,
      step: 1,
      call_id: "c1",
      name: "read",
      content: "A=1\u0000B=2\u0000",
      is_error: false,
      images: [],
    });
    expect((row.event as { content: string }).content).toBe("A=1\ufffdB=2\ufffd");
  });

  it("read watermark clears unread across id flavors (seq is the order)", async () => {
    // The client-supplied message id doubles as the user_message event id
    // (idempotency contract) and is a random uuid v4 — it sorts ABOVE every
    // uuid v7 event. The unread projection must order by seq, not id, or
    // the read dot never clears (2026-10-04 regression).
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/chats",
      headers: auth(stack.memberToken),
      payload: {},
    });
    const chat = JSON.parse(created.body) as { id: string };
    const platform = (stack.env.app as unknown as { platform: PlatformContext }).platform;
    await platform.threads.appendEvent(
      chat.id,
      { type: "user_message", content: "client v4 id", attachments: [] },
      "f7ffffff-ffff-4fff-8fff-ffffffffffff", // uuid v4-shaped, sorts high
    );
    await platform.threads.appendEvent(
      chat.id,
      { type: "assistant_message", turn: 1, step: 1, blocks: [{ type: "text", text: "turn reply" }], usage: { tokens_in: 1, tokens_out: 1 }, model: "test-model" },
      "00000000-0000-7000-8000-000000000001", // uuid v7-shaped, sorts low
    );
    const listUnread = async () => {
      const res = await stack.env.app.inject({
        method: "GET",
        url: "/api/v1/chats",
        headers: auth(stack.memberToken),
      });
      const chats = (JSON.parse(res.body) as { chats: { id: string; unread: boolean }[] }).chats;
      return chats.find((c) => c.id === chat.id)!.unread;
    };
    expect(await listUnread()).toBe(true);
    const read = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/chats/${chat.id}/read`,
      headers: auth(stack.memberToken),
      payload: {},
    });
    expect(read.statusCode).toBe(200);
    // The v4 user event out-sorts the v7 marker id — seq ordering must say read.
    expect(await listUnread()).toBe(false);
    // A newer turn re-marks the chat unread.
    await platform.threads.appendEvent(
      chat.id,
      { type: "assistant_message", turn: 2, step: 2, blocks: [{ type: "text", text: "second turn" }], usage: { tokens_in: 1, tokens_out: 1 }, model: "test-model" },
    );
    expect(await listUnread()).toBe(true);
  });
});

describe("gateway/chat turn flow", () => {
  it("runs a turn end-to-end: ack, thread events, metered usage, settled command", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/chats",
      headers: auth(stack.memberToken),
      payload: { title: "turn chat" },
    });
    const chat = JSON.parse(created.body) as { id: string };

    const res = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/gateway/chat",
      headers: auth(stack.memberToken),
      payload: {
        chat_id: chat.id,
        model: "GLM-Test-Model",
        messages: [{ role: "user", content: "say hello" }],
      },
    });
    expect(res.statusCode).toBe(200);
    const ack = JSON.parse(res.body) as Record<string, unknown>;
    // Sorted-key ack (json!-style).
    expect(Object.keys(ack)).toEqual([
      "accepted",
      "generation_id",
      "invocation_id",
      "queued",
      "status",
      "user_message_id",
    ]);
    expect(ack.accepted).toBe(true);
    expect(ack.status).toBe("submitted");

    // The thread log carries the user event + the assistant event with
    // usage + cost (persisted by the bridge from the durable run).
    await waitFor(async () => {
      const thread = await stack.env.app.inject({
        method: "GET",
        url: `/api/v1/chats/${chat.id}/thread`,
        headers: auth(stack.memberToken),
      });
      const events = (JSON.parse(thread.body) as { events: { event: { type: string } }[] }).events;
      return events.some((e) => e.event.type === "assistant_message");
    });
    const thread = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/chats/${chat.id}/thread`,
      headers: auth(stack.memberToken),
    });
    const rows = (JSON.parse(thread.body) as { events: { event: Record<string, unknown> }[] }).events;
    const user = rows.find((r) => r.event.type === "user_message");
    const assistant = rows.find((r) => r.event.type === "assistant_message");
    expect((user!.event as { content: string }).content).toBe("say hello");
    const blocks = (assistant!.event as { blocks: { type: string; text?: string }[] }).blocks;
    expect(blocks.some((b) => b.type === "text" && b.text === "hello")).toBe(true);
    const usage = (assistant!.event as { usage: { tokens_in: number; tokens_out: number; cost_usd: number } }).usage;
    expect(usage.tokens_in).toBe(3);
    expect(usage.tokens_out).toBe(2);
    // 3 in × 2 $/Mtok + 2 out × 4 $/Mtok = 0.000014 (route prices).
    expect(usage.cost_usd).toBeCloseTo(0.000014, 9);

    // The durable run was metered through the gateway with the internal key
    // (the harness's /openai/v1 call carries x-guild-org-id).
    await stack.drain();
    const usageRows = await stack.usageRows();
    expect(usageRows.some((r) => r.model === "GLM-Test-Model")).toBe(true);

    // The turn command settled answered with the durable submission id.
    const db = stack.env.db;
    const commands = await db.query<{ status: string; invocation_id: string }>(
      "SELECT status, invocation_id FROM turn_commands WHERE chat_id = $1",
      [chat.id],
    );
    expect(commands.rows).toHaveLength(1);
    expect(commands.rows[0]!.status).toBe("completed");
    expect(commands.rows[0]!.invocation_id).toMatch(/^sub:/);

    // generating settled back to false.
    const chatAfter = await db.query<{ generating: boolean }>("SELECT generating FROM chats WHERE id = $1", [chat.id]);
    expect(chatAfter.rows[0]!.generating).toBe(false);

    // Idempotent resend: the same user_message_id returns the same ack and
    // adds no turn.
    const again = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/gateway/chat",
      headers: auth(stack.memberToken),
      payload: {
        chat_id: chat.id,
        model: "GLM-Test-Model",
        messages: [{ role: "user", content: "say hello" }],
        user_message_id: ack.user_message_id,
      },
    });
    const againAck = JSON.parse(again.body) as Record<string, unknown>;
    // Same command identity; the status may have advanced past the first
    // ack (the turn completes asynchronously).
    expect(againAck["accepted"]).toBe(true);
    expect(againAck["user_message_id"]).toBe(ack.user_message_id);
    expect(againAck["invocation_id"]).toBe(ack.invocation_id);
    expect(againAck["generation_id"]).toBe(ack.generation_id);
    const commandsAfter = await db.query("SELECT count(*) n FROM turn_commands WHERE chat_id = $1", [chat.id]);
    expect(Number(commandsAfter.rows[0]!.n)).toBe(1);
  }, TEST_TIMEOUT);

  it("rejects malformed submissions with the serde-style 422 text", async () => {
    for (const payload of [
      { model: "GLM-Test-Model", messages: [] },
      { chat_id: crypto.randomUUID(), messages: [] },
      { chat_id: crypto.randomUUID(), model: "GLM-Test-Model" },
      { chat_id: crypto.randomUUID(), model: "GLM-Test-Model", messages: "no" },
    ]) {
      const res = await stack.env.app.inject({
        method: "POST",
        url: "/api/v1/gateway/chat",
        headers: auth(stack.memberToken),
        payload,
      });
      expect(res.statusCode).toBe(422);
      expect(res.headers["content-type"]).toContain("text/plain");
    }
  });

  it("streams ThreadState frames over the SSE endpoint while a turn runs", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/chats",
      headers: auth(stack.memberToken),
      payload: { title: "sse chat" },
    });
    const chat = JSON.parse(created.body) as { id: string };

    // Real HTTP listener (inject cannot stream hijacked replies).
    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/chats/${chat.id}/thread/stream`, {
      headers: { authorization: `Bearer ${stack.memberToken}` },
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    const frames: string[] = [];
    let pumpError: unknown = undefined;
    // Continuous pump: frames accumulate while the test waits on them.
    let buffer = "";
    const pump = (async (): Promise<void> => {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let index: number;
          while ((index = buffer.indexOf("\n\n")) >= 0) {
            frames.push(buffer.slice(0, index + 2));
            buffer = buffer.slice(index + 2);
          }
        }
      } catch (error) {
        pumpError = error; // the abort at test end
      }
    })();
    const readFrames = async (count: number): Promise<void> => {
      const deadline = Date.now() + 15000;
      while (frames.length < count && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (frames.length < count) throw new Error(`only ${frames.length}/${count} SSE frames`);
    };

    // Initial frame: the atomic view (empty thread).
    await readFrames(1);
    const initial = JSON.parse(frames[0]!.replace(/^data: /, "").trim()) as Record<string, unknown>;
    expect(initial["type"]).toBe("thread_state");
    expect(initial["chat_id"]).toBe(chat.id);
    expect(Array.isArray(initial["events"])).toBe(true);
    expect(frames[0]!.startsWith("data: ")).toBe(true);
    expect(frames[0]!.endsWith("\n\n")).toBe(true);

    // Submit a turn; the committed events + generating flips republish.
    await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/gateway/chat",
      headers: auth(stack.memberToken),
      payload: { chat_id: chat.id, model: "GLM-Test-Model", messages: [{ role: "user", content: "stream me" }] },
    });
    await readFrames(3);
    await waitFor(async () => {
      // The last frame must show the completed turn (assistant persisted,
      // generating false).
      const last = JSON.parse((frames[frames.length - 1]!.replace(/^data: /, "")).trim()) as {
        generating: boolean;
        events: { event: { type: string } }[];
      };
      return !last.generating && last.events.some((e) => e.event.type === "assistant_message");
    }, 15000);
    const final = JSON.parse((frames[frames.length - 1]!.replace(/^data: /, "")).trim()) as {
      seq: number;
      events: { seq: number }[];
      generating: boolean;
    };
    // Watermark strictly newer than every row it carries.
    expect(final.seq).toBeGreaterThan(Math.max(...final.events.map((e) => e.seq)));
    controller.abort();
    void pump;
    void pumpError;
  }, TEST_TIMEOUT);

  it("a queued send's echo delivers even when the run closes within one watch batch", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/chats",
      headers: auth(stack.memberToken),
      payload: { title: "queue delivery chat" },
    });
    const chat = JSON.parse(created.body) as { id: string };
    // First response slow (the chat is generating when the queued send
    // arrives), second response fast (the queued turn's placement→done
    // window closes inside one watch batch — the regression case).
    stack.mock.setResponses([
      {
        chunks: [
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
          sseDelta("slow "),
          sseDelta("turn "),
          sseDelta("one "),
          sseDelta("two "),
          sseDelta("three"),
          sseDone(),
        ],
        chunkDelayMs: 300,
      },
      {
        body:
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
          sseDelta("fast queued answer") +
          sseDone(),
      },
    ]);
    const first = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/gateway/chat",
      headers: auth(stack.memberToken),
      payload: { chat_id: chat.id, model: "GLM-Test-Model", messages: [{ role: "user", content: "slow one" }] },
    });
    expect(first.statusCode).toBe(200);
    await waitFor(async () => stack.mock.requests.length >= 1);
    const queued = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/gateway/chat",
      headers: auth(stack.memberToken),
      payload: {
        chat_id: chat.id,
        model: "GLM-Test-Model",
        send_mode: "queue",
        messages: [{ role: "user", content: "queued one" }],
      },
    });
    expect(queued.statusCode).toBe(200);
    const ack = JSON.parse(queued.body) as { user_message_id: string };
    // Both turns settle; the queued echo's `queued` flag must clear — the
    // bridge saw only the terminal submission status, and delivery must
    // still happen (a stuck flagged row renders as a forever-queued chip).
    await waitFor(async () => {
      const cmd = await stack.env.db.query<{ status: string }>(
        "SELECT status FROM turn_commands WHERE id = $1",
        [ack.user_message_id],
      );
      return cmd.rows[0]?.status === "completed";
    }, 15_000);
    await waitFor(async () => {
      const row = await stack.env.db.query<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM thread_events WHERE id = $1",
        [ack.user_message_id],
      );
      return row.rows[0] !== undefined && row.rows[0]!.payload.queued !== true;
    }, 15_000);
    // Restore the default script for the remaining tests.
    stack.mock.setResponses([
      {
        body:
          'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
          "data: [DONE]\n\n",
      },
    ]);
  }, TEST_TIMEOUT);

  it("stop answers stopped:true and compacts answer ok", async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/chats",
      headers: auth(stack.memberToken),
      payload: { title: "stop chat" },
    });
    const chat = JSON.parse(created.body) as { id: string };
    const stop = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/gateway/chat/${chat.id}/stop`,
      headers: auth(stack.memberToken),
      payload: {},
    });
    expect(stop.statusCode).toBe(200);
    expect(JSON.parse(stop.body)).toEqual({ stopped: true });

    const compact = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/gateway/chat/${chat.id}/compact`,
      headers: auth(stack.memberToken),
      payload: {},
    });
    expect(compact.statusCode).toBe(200);
    expect(JSON.parse(compact.body)).toEqual({ ok: true });
  }, TEST_TIMEOUT);
});