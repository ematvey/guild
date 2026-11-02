// The member-socket feed (ws-feed lane) against the real app + harness +
// mock provider: turn completion reaches the connected socket (the defect
// this lane fixes — a submitted turn used to hang the client forever),
// sync brackets carry the byte-exact ThreadState, commits fan out to every
// socket of the chat's owner only, org events reach the org, and machine
// presence flips re-send the thread list.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupM2Stack, startMockUpstream, type M2Stack } from "./platform/m2-harness.js";
import { ScriptedClient } from "./platform/ws-driver.js";
import { threadStateWire } from "../chats/thread-state.js";
import { notifySubagentTree } from "../agents/tree.js";
import type { PlatformContext } from "../composition.js";
import type { FeedDeps } from "../hub/feed.js";
import { FeedForwarder } from "../hub/feed.js";
import type { NotifyHandler } from "../platform/notify.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { UserEntry } from "@earendil-works/pi-durable";
import { guildProviderId } from "../harness/models.js";

// The turn flow waits on async bridge writes + the notify round-trip.
const TEST_TIMEOUT = 30_000;

let stack: M2Stack;
let slowMock: Awaited<ReturnType<typeof startMockUpstream>>;
let port: number;
let base: string;
let platform: PlatformContext;

beforeAll(async () => {
  // Pre-allocate the loopback port the harness's selfBaseUrl needs (the
  // runtime calls the app's own /openai/v1 over TCP).
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error === undefined ? resolve() : reject(error))));
  stack = await setupM2Stack({ GUILD_SELF_BASE_URL: `http://127.0.0.1:${port}` }, { dbPrefix: "guild_fix_test_" });
  await stack.env.app.listen({ port, host: "127.0.0.1" });
  base = `http://127.0.0.1:${port}`;
  platform = (stack.env.app as unknown as { platform: PlatformContext }).platform;
  await stack.routeModel("GLM-Test-Model");

  // A slow-streaming model: chunks arrive 250 ms apart, so the durable
  // partial commits between them and the bridge sees real message_update
  // deltas (the fast default mock finishes inside one commit window).
  slowMock = await startMockUpstream([
    {
      chunks: [
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n',
        "data: [DONE]\n\n",
      ],
      chunkDelayMs: 250,
    },
  ]);
  const prov = await stack.env.app.inject({
    method: "POST",
    url: "/api/v1/admin/gateway/providers",
    headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
    payload: { name: "Mock Slow OpenAI", protocol: "openai", base_url: slowMock.url, key: "sk-mock" },
  });
  if (prov.statusCode !== 200 && prov.statusCode !== 409) throw new Error(`slow provider create failed: ${prov.body}`);
  const route = await stack.env.app.inject({
    method: "PUT",
    url: "/api/v1/admin/gateway/routes",
    headers: { authorization: `Bearer ${stack.adminToken}`, "content-type": "application/json" },
    payload: { model: "GLM-Slow-Model", provider: "mock-slow-openai", price_in: 2.0, price_out: 4.0, quota_monthly_usd: null },
  });
  if (route.statusCode !== 200) throw new Error(`slow route create failed: ${route.body}`);
}, 60_000);

afterAll(async () => {
  await slowMock.stop();
  await stack.close();
}, 30_000);

const auth = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

async function createChat(title: string): Promise<{ id: string }> {
  const res = await stack.env.app.inject({
    method: "POST",
    url: "/api/v1/chats",
    headers: auth(stack.memberToken),
    payload: { title },
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as { id: string };
}

/** A connected member-socket client (post-hello, post-thread_list). */
async function memberSocket(token = stack.memberToken): Promise<ScriptedClient> {
  const res = await stack.env.app.inject({
    method: "POST",
    url: "/api/v1/ws/ticket",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  const ticket = (JSON.parse(res.body) as { ticket: string }).ticket;
  const ws = new ScriptedClient(base, `ticket=${ticket}&client_id=${crypto.randomUUID()}`);
  await ws.open();
  await ws.until((f) => f.kind === "text" && f.data.includes("thread_list"));
  return ws;
}

function textFrames(ws: ScriptedClient): Record<string, unknown>[] {
  return ws.frames
    .filter((f): f is { kind: "text"; data: string } => f.kind === "text")
    .map((f) => JSON.parse(f.data) as Record<string, unknown>);
}

async function waitFrame(
  ws: ScriptedClient,
  predicate: (frame: Record<string, unknown>) => boolean,
  timeoutMs = 15_000,
): Promise<Record<string, unknown>> {
  const found = await ws.until(
    (f) => {
      if (f.kind !== "text") return false;
      try {
        return predicate(JSON.parse(f.data) as Record<string, unknown>);
      } catch {
        return false;
      }
    },
    timeoutMs,
  );
  return JSON.parse((found as { data: string }).data) as Record<string, unknown>;
}

/** Polls an async condition until it holds; throws when the deadline passes. */
async function eventually(probe: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`condition not met within ${timeoutMs}ms`);
}

/** A second member user + live session token (org-scoped stranger). */
async function strangerToken(email: string, orgId = stack.orgId): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await stack.env.db.query(
    `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
     VALUES (gen_random_uuid(), $1, $2, '', 'member', 'managed')`,
    [orgId, email],
  );
  await stack.env.db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, auth_generation)
     SELECT $1, id, now() + interval '1 day', auth_generation FROM users WHERE email = $2`,
    [crypto.createHash("sha256").update(token).digest("hex"), email],
  );
  return token;
}

describe("member-socket feed", () => {
  it("delivers a submitted turn's live frames and terminal state to the socket (the hang fix)", { timeout: TEST_TIMEOUT }, async () => {
    const chat = await createChat("feed turn");
    const ws = await memberSocket();

    // The CLI's flow (crates/app-server/src/cloud.rs): connect → wait
    // thread_list → POST the turn while buffering live frames → filter by
    // the ack's generation_id → stream until the terminal Done/Error.
    const command = fetch(`${base}/api/v1/gateway/chat`, {
      method: "POST",
      headers: auth(stack.memberToken),
      body: JSON.stringify({
        chat_id: chat.id,
        model: "GLM-Slow-Model",
        messages: [{ role: "user", content: "say hello" }],
      }),
    });

    // chat_status generating=true arrives while the submission is in flight.
    const started = await waitFrame(
      ws,
      (f) => f.type === "chat_status" && f.chat_id === chat.id && f.generating === true,
    );
    expect(started.chat_id).toBe(chat.id);

    const res = await command;
    expect(res.status).toBe(200);
    const ack = JSON.parse(await res.text()) as { generation_id: string; accepted: boolean };
    expect(ack.accepted).toBe(true);

    // Live frames for THIS generation stream in and end terminal.
    const done = await waitFrame(
      ws,
      (f) =>
        f.type === "live_frame" &&
        f.chat_id === chat.id &&
        f.generation_id === ack.generation_id &&
        (f.event as { type: string }).type === "done",
      20_000,
    );
    const doneEvent = done.event as { message_id: string; cost_usd: number; tokens_in: number; tokens_out: number };
    expect(doneEvent.tokens_in).toBe(3);
    expect(doneEvent.tokens_out).toBe(2);
    expect(doneEvent.cost_usd).toBeCloseTo(0.000014, 9);
    // The terminal message_id is the persisted assistant row.
    const assistantRow = await stack.env.db.query<{ id: string }>(
      "SELECT id FROM thread_events WHERE chat_id = $1 AND type = 'assistant_message'",
      [chat.id],
    );
    expect(assistantRow.rows).toHaveLength(1);
    expect(doneEvent.message_id).toBe(assistantRow.rows[0]!.id);

    // The streamed deltas reconstruct the model's text.
    const deltas = textFrames(ws)
      .filter((f) => f.type === "live_frame" && f.generation_id === ack.generation_id)
      .map((f) => (f.event as { type: string; content?: string }).content ?? "")
      .join("");
    expect(deltas).toContain("hello");

    // The committed view reaches the socket and matches the durable log
    // exactly (row ids, order, generating settled false).
    const finalView = await waitFrame(
      ws,
      (f) =>
        f.type === "thread_state" &&
        f.chat_id === chat.id &&
        !f.generating &&
        (f.events as { event: { type: string } }[]).some((e) => e.event.type === "assistant_message"),
      20_000,
    );
    const events = finalView.events as { id: string; seq: number; event: { type: string } }[];
    const types = events.map((e) => e.event.type);
    expect(types).toEqual(["user_message", "assistant_message"]);
    const persisted = await stack.env.db.query<{ id: string; type: string }>(
      "SELECT id, type FROM thread_events WHERE chat_id = $1 ORDER BY seq",
      [chat.id],
    );
    expect(persisted.rows.map((r) => r.type)).toEqual(types);
    expect(events.map((e) => e.id)).toEqual(persisted.rows.map((r) => r.id));
    // The view's watermark is strictly newer than every row it carries.
    expect(finalView.seq as number).toBeGreaterThan(Math.max(...events.map((e) => e.seq)));

    // The spinner settles.
    await waitFrame(ws, (f) => f.type === "chat_status" && f.chat_id === chat.id && f.generating === false);

    const commands = await stack.env.db.query<{ status: string }>(
      "SELECT status FROM turn_commands WHERE chat_id = $1",
      [chat.id],
    );
    expect(commands.rows[0]!.status).toBe("completed");
    ws.end();
  });

  it("delivers mid-turn journal rows to the socket before the run-end view", { timeout: TEST_TIMEOUT }, async () => {
    const chat = await createChat("feed incremental");
    const ws = await memberSocket();

    // The turn's user_message lands in the durable journal while the slow
    // model is still streaming. It must reach the socket mid-turn — as a
    // thread_events frame (the incremental fan-out) or an early generating
    // view — not only inside the run-end ThreadState.
    void fetch(`${base}/api/v1/gateway/chat`, {
      method: "POST",
      headers: auth(stack.memberToken),
      body: JSON.stringify({
        chat_id: chat.id,
        model: "GLM-Slow-Model",
        messages: [{ role: "user", content: "say hello" }],
      }),
    });
    const midTurn = await waitFrame(
      ws,
      (f) =>
        f.chat_id === chat.id &&
        ((f.type === "thread_events" &&
          (f.events as { event: { type: string } }[]).some((e) => e.event.type === "user_message")) ||
          (f.type === "thread_state" && f.generating === true &&
            (f.events as { event: { type: string } }[]).some((e) => e.event.type === "user_message"))),
      20_000,
    );
    const rows = midTurn.events as { seq: number; event: { type: string } }[];
    expect(rows.map((e) => e.event.type)).toContain("user_message");
    if (midTurn.type === "thread_events") {
      // The frame's watermark is at least the newest row it carries.
      expect(midTurn.seq as number).toBeGreaterThanOrEqual(Math.max(...rows.map((r) => r.seq)));
    }

    // The run-end view still settles the thread (full reconcile).
    await waitFrame(
      ws,
      (f) =>
        f.type === "thread_state" &&
        f.chat_id === chat.id &&
        !f.generating &&
        (f.events as { event: { type: string } }[]).some((e) => e.event.type === "assistant_message"),
      20_000,
    );
    ws.end();
  });

  it("answers sync with SyncBegin → SubagentTree → byte-exact ThreadState → SyncDone", { timeout: TEST_TIMEOUT }, async () => {
    const chat = await createChat("sync chat");
    const ws = await memberSocket();

    // A committed event so the bracket carries rows.
    const append = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/chats/${chat.id}/thread`,
      headers: auth(stack.memberToken),
      payload: { type: "system_message", content: "sync marker" },
    });
    expect(append.statusCode).toBe(200);
    await waitFrame(ws, (f) => f.type === "thread_state" && f.chat_id === chat.id);

    ws.send(JSON.stringify({ type: "sync", chat_id: chat.id }));
    const beginIdx = await ws.until((f) => f.kind === "text" && f.data.includes("sync_begin"));
    const beginPos = ws.frames.indexOf(beginIdx);
    const treeFrame = ws.frames
      .slice(beginPos)
      .find((f) => f.kind === "text" && (JSON.parse(f.data) as Record<string, unknown>).type === "subagent_tree");
    expect(treeFrame).toBeDefined();
    const stateFrame = ws.frames
      .slice(beginPos)
      .find((f) => f.kind === "text" && (JSON.parse(f.data) as Record<string, unknown>).type === "thread_state");
    expect(stateFrame).toBeDefined();
    expect(ws.frames.indexOf(treeFrame!)).toBeLessThan(ws.frames.indexOf(stateFrame!));
    const state = JSON.parse((stateFrame as { data: string }).data) as Record<string, unknown>;
    const doneFrame = ws.frames
      .slice(beginPos)
      .find((f) => f.kind === "text" && (JSON.parse(f.data) as Record<string, unknown>).type === "sync_done");
    expect(doneFrame).toBeDefined();

    // Byte fidelity: rebuilding the capture in-process renders the exact
    // same bytes the socket received (serde variant order, sorted ryu rows).
    const rows = await platform.threads.listEvents(stack.orgId, chat.id);
    const rebuilt = threadStateWire({
      chatId: chat.id,
      seq: state.seq as number,
      events: rows,
      text: state.text as string,
      thinking: state.thinking as string,
      generating: state.generating as boolean,
      projectId: state.project_id as string | undefined,
      projectName: state.project_name as string | undefined,
      projectMachineLabel: state.project_machine_label as string | undefined,
      hasMoreEvents: false,
      compacting: state.compacting as boolean | undefined,
    });
    expect((stateFrame as { data: string }).data).toBe(rebuilt);

    // A stranger's sync: the owner-gate error rides INSIDE the bracket.
    const token = await strangerToken("fix-sync-stranger@example.test");
    const foreignWs = await memberSocket(token);
    foreignWs.send(JSON.stringify({ type: "sync", chat_id: chat.id }));
    const err = await waitFrame(foreignWs, (f) => f.type === "error");
    expect(err.message).toBe("no such chat");
    const errDone = await waitFrame(foreignWs, (f) => f.type === "sync_done" && f.chat_id === chat.id);
    void errDone;
    foreignWs.end();
    ws.end();
  });

  it("sends no subagent tree for a chat the caller cannot read", { timeout: TEST_TIMEOUT }, async () => {
    const chat = await createChat("tree gate");
    const otherOrg = crypto.randomUUID();
    await stack.env.db.query("INSERT INTO orgs (id, name) VALUES ($1, 'tree gate org')", [otherOrg]);
    const tokens = [
      await strangerToken("tree-gate-member@example.test"),
      await strangerToken("tree-gate-foreign@example.test", otherOrg),
    ];
    for (const token of tokens) {
      const ws = await memberSocket(token);
      ws.send(JSON.stringify({ type: "sync", chat_id: chat.id }));
      await waitFrame(ws, (f) => f.type === "sync_done" && f.chat_id === chat.id);
      const frames = textFrames(ws);
      expect(frames.some((f) => f.type === "subagent_tree")).toBe(false);
      expect(frames.some((f) => f.type === "thread_state" && f.chat_id === chat.id)).toBe(false);
      expect(frames.some((f) => f.type === "error" && f.message === "no such chat")).toBe(true);
      ws.end();
    }
  });

  it("sends ThreadState even when the child-tree read rejects", { timeout: TEST_TIMEOUT }, async () => {
    const chat = await createChat("sync tree failure");
    const ws = await memberSocket();
    const originalTree = platform.sockets.subagentTree;
    platform.sockets.subagentTree = async () => {
      throw new Error("tree read failed");
    };
    try {
      ws.send(JSON.stringify({ type: "sync", chat_id: chat.id }));
      const state = await waitFrame(ws, (f) => f.type === "thread_state" && f.chat_id === chat.id);
      expect(state.chat_id).toBe(chat.id);
      const done = await waitFrame(ws, (f) => f.type === "sync_done" && f.chat_id === chat.id);
      expect(done.chat_id).toBe(chat.id);
      const trees = textFrames(ws).filter((f) => f.type === "subagent_tree" && f.chat_id === chat.id);
      expect(trees).toHaveLength(0);
    } finally {
      platform.sockets.subagentTree = originalTree;
      ws.end();
    }
  });

  it("does not stall live frames when validation drops a sync request", { timeout: TEST_TIMEOUT }, async () => {
    const chat = await createChat("dropped sync");
    const ws = await memberSocket();
    const orgRes = await stack.env.db.query<{ id: string }>(
      "INSERT INTO orgs (id, name) VALUES (gen_random_uuid(), 'fix-dropped-sync') RETURNING id",
    );
    const otherOrg = orgRes.rows[0]!.id;
    try {
      // The next client message reads the member in another org, so
      // processClient returns before the bracket opens.
      await stack.env.db.query("UPDATE users SET org_id = $1 WHERE id = $2", [otherOrg, stack.memberId]);
      ws.send(JSON.stringify({ type: "sync", chat_id: chat.id }));
      // A live frame after the dropped sync must still arrive: no orphan
      // sync_start may hold the gate open.
      await stack.env.db.query("SELECT pg_notify('guild_chat_status', $1)", [
        JSON.stringify({
          org_id: stack.orgId,
          user_id: stack.memberId,
          chat_id: chat.id,
          generating: true,
        }),
      ]);
      const status = await waitFrame(ws, (f) => f.type === "chat_status" && f.chat_id === chat.id);
      expect(status.generating).toBe(true);
      // Give the dropped sync time to drain, then check it opened nothing.
      await new Promise((resolve) => setTimeout(resolve, 250));
      const syncFrames = textFrames(ws).filter(
        (f) => f.type === "sync_begin" || f.type === "sync_done",
      );
      expect(syncFrames).toEqual([]);
    } finally {
      await stack.env.db.query("UPDATE users SET org_id = $1 WHERE id = $2", [stack.orgId, stack.memberId]);
      ws.end();
    }
  });

  it("defers a live tree that arrives inside a sync bracket until after SyncDone", { timeout: TEST_TIMEOUT }, async () => {
    const chat = await createChat("sync gate");
    const agentId = crypto.randomUUID();
    await stack.env.db.query(
      `INSERT INTO agents (id, org_id, owner_user_id, name, model)
       VALUES ($1, $2, $3, 'Sync gate agent', 'GLM-Test-Model')`,
      [agentId, stack.orgId, stack.memberId],
    );
    const rootThread = crypto.randomUUID();
    await stack.env.db.query(
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, type)
       VALUES ($1, $2, $3, $4, 'Root session', 'user')`,
      [rootThread, agentId, stack.memberId, chat.id],
    );
    const childChat = await createChat("sync gate child");
    const childThread = crypto.randomUUID();
    await stack.env.db.query(
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, type, parent_thread_id, depth)
       VALUES ($1, $2, $3, $4, 'Child session', 'subagent', $5, 1)`,
      [childThread, agentId, stack.memberId, childChat.id, rootThread],
    );
    const runId = crypto.randomUUID();
    await stack.env.db.query(
      `INSERT INTO agent_runs (id, agent_id, user_id, thread_id, trigger, status, started_at)
       VALUES ($1, $2, $3, $4, 'delegation', 'running', now())`,
      [runId, agentId, stack.memberId, childThread],
    );

    const ws = await memberSocket();
    const originalTree = platform.sockets.subagentTree;
    let releaseTree: () => void = () => {};
    const treeGate = new Promise<void>((resolve) => { releaseTree = resolve; });
    platform.sockets.subagentTree = async (args) => {
      await treeGate;
      return originalTree(args);
    };
    // Observe the live frame entering the sink: once it is queued while the
    // bracket is still open, the gate must defer it. No production hook.
    const sinks = platform.hub.sinksOfUser(stack.memberId);
    let markQueued: () => void = () => {};
    const queued = new Promise<void>((resolve) => { markQueued = resolve; });
    const restoreSends = sinks.map((sink) => {
      const original = sink.send.bind(sink);
      sink.send = (msg: Parameters<typeof sink.send>[0]) => {
        if (msg.type === "subagent_tree" && msg.chat_id === chat.id) markQueued();
        return original(msg);
      };
      return () => { sink.send = original; };
    });
    try {
      ws.send(JSON.stringify({ type: "sync", chat_id: chat.id }));
      await ws.until((f) => f.kind === "text" && f.data.includes("sync_begin"));
      // The bracket is open. A live tree push for the same chat arrives now.
      await notifySubagentTree(platform.pool, childThread);
      await Promise.race([
        queued,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("live tree never reached the sink")), 5_000),
        ),
      ]);
      releaseTree();

      // The bracket's own tree and state arrive first; the deferred live tree
      // follows SyncDone.
      await waitFrame(ws, (f) => f.type === "sync_done" && f.chat_id === chat.id);
      await ws.until(
        (f) =>
          f.kind === "text" &&
          (JSON.parse(f.data) as Record<string, unknown>).type === "subagent_tree" &&
          textFrames(ws).filter((frame) => frame.type === "subagent_tree").length >= 2,
        5_000,
      );

      const frames = textFrames(ws);
      const beginIndex = frames.findIndex((f) => f.type === "sync_begin" && f.chat_id === chat.id);
      const stateIndex = frames.findIndex((f) => f.type === "thread_state" && f.chat_id === chat.id);
      const doneIndex = frames.findIndex((f) => f.type === "sync_done" && f.chat_id === chat.id);
      const treeFrames = frames
        .map((frame, index) => ({ frame, index }))
        .filter(({ frame, index }) => index > beginIndex && frame.type === "subagent_tree" && frame.chat_id === chat.id);
      expect(treeFrames.length).toBeGreaterThanOrEqual(2);
      const bracketTree = treeFrames[0]!;
      const liveTree = treeFrames[treeFrames.length - 1]!;
      expect(bracketTree.index).toBeLessThan(stateIndex);
      expect(stateIndex).toBeLessThan(doneIndex);
      expect(doneIndex).toBeLessThan(liveTree.index);
      expect((bracketTree.frame.nodes as { status: string | null }[]).some((n) => n.status === "running")).toBe(true);
    } finally {
      for (const restore of restoreSends) restore();
      platform.sockets.subagentTree = originalTree;
      ws.end();
    }
  });

  it("fans a committed event out to every socket of the owner, and to no stranger", { timeout: TEST_TIMEOUT }, async () => {
    const chat = await createChat("fanout chat");
    const first = await memberSocket();
    const second = await memberSocket();
    const stranger = await memberSocket(await strangerToken("fix-fanout-stranger@example.test"));

    const before = stranger.frames.length;
    const res = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/chats/${chat.id}/thread`,
      headers: auth(stack.memberToken),
      payload: { type: "system_message", content: "fanout" },
    });
    expect(res.statusCode).toBe(200);

    for (const ws of [first, second]) {
      const view = await waitFrame(ws, (f) => f.type === "thread_state" && f.chat_id === chat.id);
      const events = view.events as { event: { type: string; content?: string } }[];
      expect(events.some((e) => e.event.type === "system_message" && e.event.content === "fanout")).toBe(true);
      // One commit → exactly one view per socket (the seq-zeroed dedupe
      // never re-sends an identical capture).
      const count = textFrames(ws).filter((f) => f.type === "thread_state" && f.chat_id === chat.id).length;
      expect(count).toBe(1);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
    const strangerText = stranger.frames
      .slice(before)
      .filter((f) => f.kind === "text")
      .map((f) => (JSON.parse(f.data) as Record<string, unknown>).type);
    expect(strangerText).toEqual([]);

    first.end();
    second.end();
    stranger.end();
  });

  it("delivers org events to the org's sockets", { timeout: TEST_TIMEOUT }, async () => {
    const ws = await memberSocket();
    const event = await platform.events.emit(stack.orgId, "fix_test", { marker: "org-ping" });
    const frame = await waitFrame(ws, (f) => f.type === "org_event");
    const payload = frame.event as { id: string; kind: string; payload: unknown };
    expect(payload.id).toBe(event.id);
    expect(payload.kind).toBe("fix_test");
    ws.end();
  });

  it("re-sends the thread list when a bound machine's presence flips", { timeout: TEST_TIMEOUT }, async () => {
    const chat = await createChat("presence chat");
    // Bind the chat to a machine row (registry row + chat binding).
    await stack.env.db.query(
      `INSERT INTO machines (machine_id, org_id, user_id, label)
       VALUES ('fix-presence-m1', $1, $2, 'Desk')`,
      [stack.orgId, stack.memberId],
    );
    await stack.env.db.query("UPDATE chats SET machine_id = 'fix-presence-m1', machine_label = 'Desk' WHERE id = $1", [chat.id]);

    const browser = await memberSocket();
    // One presence poll passes while the machine is still offline, so the
    // online flip below is guaranteed to be observed as a change.
    await new Promise((resolve) => setTimeout(resolve, 1_300));

    // The machine's daemon connects: the live slot flips online.
    const res = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/ws/ticket",
      headers: { authorization: `Bearer ${stack.memberToken}` },
    });
    const ticket = (JSON.parse(res.body) as { ticket: string }).ticket;
    const machine = new ScriptedClient(
      base,
      `ticket=${ticket}&client_id=${crypto.randomUUID()}&machine_id=fix-presence-m1&machine_name=Desk&instance_id=${crypto.randomUUID()}&resume=false`,
    );
    await machine.open();
    await machine.until((f) => f.kind === "text" && f.data.includes("thread_list"));

    // The browser socket learns the dot went green (presence poll).
    await waitFrame(
      browser,
      (f) =>
        f.type === "thread_list" &&
        (f.chats as { id: string; machine_online: boolean }[]).some(
          (c) => c.id === chat.id && c.machine_online === true,
        ),
      10_000,
    );

    // The daemon leaves: the dot goes gray.
    machine.end();
    await machine.closed();
    await waitFrame(
      browser,
      (f) =>
        f.type === "thread_list" &&
        (f.chats as { id: string; machine_online: boolean }[]).some(
          (c) => c.id === chat.id && c.machine_online === false,
        ),
      10_000,
    );
    browser.end();
  });

  it("pushes machine_status to the owner's member socket on connect and disconnect", { timeout: TEST_TIMEOUT }, async () => {
    const machineId = "fix-status-m1";
    await stack.env.db.query(
      `INSERT INTO machines (machine_id, org_id, user_id, label)
       VALUES ($1, $2, $3, 'Desk')`,
      [machineId, stack.orgId, stack.memberId],
    );

    const browser = await memberSocket();
    const res = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/ws/ticket",
      headers: { authorization: `Bearer ${stack.memberToken}` },
    });
    const ticket = (JSON.parse(res.body) as { ticket: string }).ticket;
    const machine = new ScriptedClient(
      base,
      `ticket=${ticket}&client_id=${crypto.randomUUID()}&machine_id=${machineId}&machine_name=Desk&instance_id=${crypto.randomUUID()}&resume=false`,
    );
    await machine.open();

    // No poll: the flip itself is a frame, so it lands at once.
    const online = await waitFrame(
      browser,
      (f) => f.type === "machine_status" && f.machine_id === machineId,
    );
    expect(online.online).toBe(true);

    machine.end();
    await machine.closed();
    const offline = await waitFrame(
      browser,
      (f) => f.type === "machine_status" && f.machine_id === machineId && f.online === false,
    );
    expect(offline.online).toBe(false);
    browser.end();
  });

  it("the HTTP thread list agrees with the hub — same truth as the machines list", { timeout: TEST_TIMEOUT }, async () => {
    // Regression: GET /api/v1/chats hardcoded machine_online=false, so the
    // webchat showed the "machine is offline" banner while the sidebar's
    // machines-derived pin showed green (an always-online machine never
    // triggers a presence-change push to correct the stale HTTP row).
    const chat = await createChat("http parity chat");
    await stack.env.db.query(
      `INSERT INTO machines (machine_id, org_id, user_id, label)
       VALUES ('fix-http-m1', $1, $2, 'Desk')`,
      [stack.orgId, stack.memberId],
    );
    await stack.env.db.query("UPDATE chats SET machine_id = 'fix-http-m1', machine_label = 'Desk' WHERE id = $1", [chat.id]);

    const onlineOf = async (): Promise<boolean | undefined> => {
      const res = await stack.env.app.inject({
        method: "GET",
        url: "/api/v1/chats",
        headers: auth(stack.memberToken),
      });
      expect(res.statusCode).toBe(200);
      const chats = (JSON.parse(res.body) as { chats: { id: string; machine_online: boolean }[] }).chats;
      return chats.find((c) => c.id === chat.id)?.machine_online;
    };
    expect(await onlineOf()).toBe(false);

    const res = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/ws/ticket",
      headers: { authorization: `Bearer ${stack.memberToken}` },
    });
    const ticket = (JSON.parse(res.body) as { ticket: string }).ticket;
    const machine = new ScriptedClient(
      base,
      `ticket=${ticket}&client_id=${crypto.randomUUID()}&machine_id=fix-http-m1&machine_name=Desk&instance_id=${crypto.randomUUID()}&resume=false`,
    );
    await machine.open();
    expect(await onlineOf()).toBe(true);

    machine.end();
    await machine.closed();
    // The socket reader clears the presence slot asynchronously after the
    // close, so poll for the HTTP row instead of assuming it is already clear.
    await eventually(async () => (await onlineOf()) === false);
    expect(await onlineOf()).toBe(false);
  });

  it("keeps a delegated child chat out of the thread_list push and the HTTP list", { timeout: TEST_TIMEOUT }, async () => {
    const chat = await createChat("delegated child");
    const agentId = crypto.randomUUID();
    await stack.env.db.query(
      "INSERT INTO agents (id, org_id, owner_user_id, name, model) VALUES ($1, $2, $3, 'Child agent', 'GLM-Slow-Model')",
      [agentId, stack.orgId, stack.memberId],
    );
    await stack.env.db.query(
      `INSERT INTO agent_threads (id, agent_id, chat_id, title, type, user_id, depth)
       VALUES ($1, $2, $3, 'Child thread', 'subagent', $4, 1)`,
      [crypto.randomUUID(), agentId, chat.id, stack.memberId],
    );

    const ws = await memberSocket();
    const list = textFrames(ws).find((frame) => frame.type === "thread_list") as
      | { chats: { id: string }[] }
      | undefined;
    expect(list).toBeDefined();
    expect(list!.chats.map((row) => row.id)).not.toContain(chat.id);
    ws.end();

    const http = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/chats",
      headers: auth(stack.memberToken),
    });
    expect(http.statusCode).toBe(200);
    const chats = (JSON.parse(http.body) as { chats: { id: string }[] }).chats;
    expect(chats.map((row) => row.id)).not.toContain(chat.id);
  });

  it("the duplex read-mark moves the caller's marker without an HTTP round trip", async () => {
    const chat = await createChat("read duplex");
    const eventId = crypto.randomUUID();
    await stack.env.db.query(
      "INSERT INTO thread_events (id, chat_id, type, payload) VALUES ($1, $2, 'user_message', $3)",
      [eventId, chat.id, JSON.stringify({ type: "user_message", text: "read me" })],
    );
    const seq = (
      await stack.env.db.query<{ seq: string }>("SELECT seq FROM thread_events WHERE id = $1", [eventId])
    ).rows[0]!.seq;

    const ws = await memberSocket();
    ws.send(JSON.stringify({ type: "read", chat_id: chat.id }));
    // The write is async (the socket reader's store call): poll briefly.
    let marker: { last_read_seq: string } | undefined;
    for (let i = 0; i < 50 && marker === undefined; i++) {
      marker = (
        await stack.env.db.query<{ last_read_seq: string }>(
          "SELECT last_read_seq FROM chat_reads WHERE chat_id = $1",
          [chat.id],
        )
      ).rows[0];
      if (marker === undefined) await new Promise((r) => setTimeout(r, 100));
    }
    expect(marker?.last_read_seq).toBe(seq);
    ws.end();
  });

  it("pushes the cleared unread dot to the user's other sockets when one client reads", async () => {
    const chat = await createChat("read fan-out");
    await stack.env.db.query(
      "INSERT INTO thread_events (id, chat_id, type, payload) VALUES ($1, $2, 'assistant_message', $3)",
      [crypto.randomUUID(), chat.id, JSON.stringify({ type: "assistant_message", text: "unread here" })],
    );

    const reader = await memberSocket();
    const other = await memberSocket();
    // The dot is up on the second tab before the read lands, so the frame
    // below can only come from the read write.
    await waitFrame(
      other,
      (f) =>
        f.type === "thread_list" &&
        (f.chats as { id: string; unread: boolean }[]).some((c) => c.id === chat.id && c.unread),
    );
    reader.send(JSON.stringify({ type: "read", chat_id: chat.id }));

    // The other tab holds no marker of its own: the only way its dot clears
    // is the read write pushing the workspace lists.
    const frame = await waitFrame(
      other,
      (f) =>
        f.type === "thread_list" &&
        (f.chats as { id: string; unread: boolean }[]).some((c) => c.id === chat.id && !c.unread),
    );
    const row = (frame.chats as { id: string; unread: boolean }[]).find((c) => c.id === chat.id)!;
    expect(row.unread).toBe(false);
    reader.end();
    other.end();
  });

  it("pushes the chat's thread subtree on sync and on every tree change", { timeout: TEST_TIMEOUT }, async () => {
    const chat = await createChat("tree push");
    const agentId = crypto.randomUUID();
    await stack.env.db.query(
      `INSERT INTO agents (id, org_id, owner_user_id, name, model)
       VALUES ($1, $2, $3, 'Tree push agent', 'GLM-Test-Model')`,
      [agentId, stack.orgId, stack.memberId],
    );
    const rootThread = crypto.randomUUID();
    expect(rootThread).not.toBe(chat.id);
    await stack.env.db.query(
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, type)
       VALUES ($1, $2, $3, $4, 'Root session', 'user')`,
      [rootThread, agentId, stack.memberId, chat.id],
    );

    const ws = await memberSocket();
    ws.send(JSON.stringify({ type: "sync", chat_id: chat.id }));
    const syncTree = await waitFrame(
      ws,
      (f) => f.type === "subagent_tree" && f.chat_id === chat.id,
    );
    expect((syncTree.nodes as { thread_id: string }[]).map((n) => n.thread_id)).toEqual([rootThread]);

    // A child thread + run changes the subtree: the NOTIFY pushes it whole.
    const childChat = await createChat("tree push child");
    expect(childChat.id).not.toBe(chat.id);
    const childThread = crypto.randomUUID();
    await stack.env.db.query(
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, type, parent_thread_id, depth)
       VALUES ($1, $2, $3, $4, 'Child session', 'subagent', $5, 1)`,
      [childThread, agentId, stack.memberId, childChat.id, rootThread],
    );
    const runId = crypto.randomUUID();
    await stack.env.db.query(
      `INSERT INTO agent_runs (id, agent_id, user_id, thread_id, trigger, status, started_at)
       VALUES ($1, $2, $3, $4, 'delegation', 'running', now())`,
      [runId, agentId, stack.memberId, childThread],
    );
    await notifySubagentTree(platform.pool, childThread);

    // The list computes working from the whole chat subtree, not only the
    // chat's own generating flag.
    const workingList = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/chats",
      headers: auth(stack.memberToken),
    });
    expect(workingList.statusCode).toBe(200);
    const workingRow = (JSON.parse(workingList.body) as { chats: { id: string; working: boolean }[] })
      .chats.find((row) => row.id === chat.id);
    expect(workingRow?.working).toBe(true);

    // The thread insert pushes the new node before its run exists; the run
    // pushes it again with its status.
    const pushed = await waitFrame(
      ws,
      (f) => f.type === "subagent_tree" && f.chat_id === chat.id
        && (f.nodes as { status: string | null }[]).length === 2
        && (f.nodes as { status: string | null }[])[1]!.status === "running",
    );
    const nodes = pushed.nodes as { thread_id: string; parent_thread_id: string | null; status: string | null }[];
    expect(nodes.map((n) => [n.thread_id, n.parent_thread_id, n.status])).toEqual([
      [rootThread, null, null],
      [childThread, rootThread, "running"],
    ]);

    // A status flip moves the same tree.
    await stack.env.db.query("UPDATE agent_runs SET status = 'succeeded' WHERE id = $1", [runId]);
    await notifySubagentTree(platform.pool, childThread);
    const done = await waitFrame(
      ws,
      (f) => f.type === "subagent_tree" && f.chat_id === chat.id
        && (f.nodes as { status: string | null }[]).some((n) => n.status === "succeeded"),
    );
    expect((done.nodes as { status: string | null }[])[1]!.status).toBe("succeeded");

    const doneList = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/chats",
      headers: auth(stack.memberToken),
    });
    expect(doneList.statusCode).toBe(200);
    const doneRow = (JSON.parse(doneList.body) as { chats: { id: string; working: boolean }[] })
      .chats.find((row) => row.id === chat.id);
    expect(doneRow?.working).toBe(false);
    ws.end();
  });
  it("pushes every workspace list on connect", { timeout: TEST_TIMEOUT }, async () => {
    const ws = await memberSocket();
    // The legacy chat list is first (old clients wait for it); the rest of
    // the sidebar state follows on the same bootstrap.
    const info = await waitFrame(ws, (f) => f.type === "workspace_identity");
    expect(info.name).toBe("m2 test org");
    await waitFrame(ws, (f) => f.type === "archived_thread_list");
    await waitFrame(ws, (f) => f.type === "project_list");
    await waitFrame(ws, (f) => f.type === "machine_list");
    ws.end();
  });

  it("pushes the workspace name to every member socket on a rename", { timeout: TEST_TIMEOUT }, async () => {
    const ws = await memberSocket();
    const renamed = await stack.env.app.inject({
      method: "PUT",
      url: "/api/v1/org",
      headers: auth(stack.adminToken),
      payload: { name: "Renamed workspace" },
    });
    expect(renamed.statusCode).toBe(200);
    const info = await waitFrame(
      ws,
      (f) => f.type === "workspace_identity" && f.name === "Renamed workspace",
    );
    expect(info.name).toBe("Renamed workspace");
    // Restore the harness's name for the tests that follow.
    await stack.env.app.inject({
      method: "PUT",
      url: "/api/v1/org",
      headers: auth(stack.adminToken),
      payload: { name: "m2 test org" },
    });
    ws.end();
  });

  it("carries the admin telemetry switch to every member socket", { timeout: TEST_TIMEOUT }, async () => {
    // On by default: a fresh workspace collects until an admin turns it off.
    const ws = await memberSocket();
    const initial = await waitFrame(ws, (f) => f.type === "workspace_identity");
    expect(initial.telemetry).toBe(true);

    // A member cannot change it; the admin can, and the frame repaints live.
    const refused = await stack.env.app.inject({
      method: "PUT",
      url: "/api/v1/org/telemetry",
      headers: auth(stack.memberToken),
      payload: { enabled: false },
    });
    expect(refused.statusCode).toBe(403);
    const off = await stack.env.app.inject({
      method: "PUT",
      url: "/api/v1/org/telemetry",
      headers: auth(stack.adminToken),
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    const pushed = await waitFrame(
      ws,
      (f) => f.type === "workspace_identity" && f.telemetry === false,
    );
    expect(pushed.telemetry).toBe(false);

    const org = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/org",
      headers: auth(stack.memberToken),
    });
    expect(JSON.parse(org.body).telemetry).toBe(false);

    // Restore the default for the tests that follow.
    await stack.env.app.inject({
      method: "PUT",
      url: "/api/v1/org/telemetry",
      headers: auth(stack.adminToken),
      payload: { enabled: true },
    });
    ws.end();
  });

  it("pushes the model list on connect and on every route change", { timeout: TEST_TIMEOUT }, async () => {
    type Models = { id: string; alias: string }[];
    const ws = await memberSocket();
    const initial = await waitFrame(ws, (f) => f.type === "model_list");
    expect((initial.models as Models).some((m) => m.id === "GLM-Slow-Model")).toBe(true);

    const added = await stack.env.app.inject({
      method: "PUT",
      url: "/api/v1/admin/gateway/routes",
      headers: auth(stack.adminToken),
      payload: { model: "GLM-Pushed-Model", alias: "Pushed", provider: "mock-slow-openai", price_in: 1, price_out: 1, quota_monthly_usd: null },
    });
    expect(added.statusCode).toBe(200);
    const pushed = await waitFrame(
      ws,
      (f) => f.type === "model_list" && (f.models as Models).some((m) => m.id === "GLM-Pushed-Model"),
    );
    expect((pushed.models as Models).find((m) => m.id === "GLM-Pushed-Model")?.alias).toBe("Pushed");

    const removed = await stack.env.app.inject({
      method: "DELETE",
      url: "/api/v1/admin/gateway/routes/GLM-Pushed-Model",
      headers: { authorization: `Bearer ${stack.adminToken}` },
    });
    expect(removed.statusCode).toBe(200);
    await waitFrame(
      ws,
      (f) => f.type === "model_list" && !(f.models as Models).some((m) => m.id === "GLM-Pushed-Model"),
    );
    ws.end();
  });

  it("pushes the updated workspace on a chat rename and archive", { timeout: TEST_TIMEOUT }, async () => {
    const chat = await createChat("rename me");
    const ws = await memberSocket();

    const renamed = await stack.env.app.inject({
      method: "PATCH",
      url: `/api/v1/threads/${chat.id}`,
      headers: auth(stack.memberToken),
      payload: { title: "Renamed chat" },
    });
    expect(renamed.statusCode).toBe(200);
    await waitFrame(
      ws,
      (f) =>
        f.type === "thread_list" &&
        (f.chats as { id: string; title?: string }[]).some(
          (c) => c.id === chat.id && c.title === "Renamed chat",
        ),
    );

    const archived = await stack.env.app.inject({
      method: "PATCH",
      url: `/api/v1/threads/${chat.id}`,
      headers: auth(stack.memberToken),
      payload: { archived: true },
    });
    expect(archived.statusCode).toBe(200);
    await waitFrame(
      ws,
      (f) =>
        f.type === "archived_thread_list" &&
        (f.chats as { id: string }[]).some((c) => c.id === chat.id),
    );
    ws.end();
  });

  it("pushes project_list when a project is created", { timeout: TEST_TIMEOUT }, async () => {
    const machineId = "fix-workspace-project-m1";
    await stack.env.db.query(
      `INSERT INTO machines (machine_id, org_id, user_id, label)
       VALUES ($1, $2, $3, 'Desk') ON CONFLICT DO NOTHING`,
      [machineId, stack.orgId, stack.memberId],
    );
    const ws = await memberSocket();
    const res = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/projects",
      headers: auth(stack.memberToken),
      payload: { folder: "/tmp/fix-workspace-project", machine_id: machineId },
    });
    expect(res.statusCode).toBe(200);
    const project = JSON.parse(res.body) as { id: string };
    await waitFrame(
      ws,
      (f) =>
        f.type === "project_list" &&
        (f.projects as { id: string }[]).some((p) => p.id === project.id),
    );
    ws.end();
  });
});

// What one change costs on the wire: a socket receives the part of the
// workspace that moved for it, a compaction's settlement always reaches the
// chat's view, and the context meter rides the socket.
describe("member-socket push volume", () => {
  /** A member socket that applies chat_row frames, past its first paint. */
  async function rowSocket(): Promise<ScriptedClient> {
    const res = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/ws/ticket",
      headers: { authorization: `Bearer ${stack.memberToken}` },
    });
    const ticket = (JSON.parse(res.body) as { ticket: string }).ticket;
    const ws = new ScriptedClient(base, `ticket=${ticket}&client_id=${crypto.randomUUID()}&features=chat_row`);
    await ws.open();
    await waitFrame(ws, (f) => f.type === "model_list");
    return ws;
  }

  const WORKSPACE_FRAMES = new Set([
    "workspace_identity",
    "thread_list",
    "archived_thread_list",
    "project_list",
    "machine_list",
    "model_list",
  ]);

  it("a plain turn sends the changed chat row and its context usage, never the workspace bracket", { timeout: TEST_TIMEOUT }, async () => {
    const chat = await createChat("push volume");
    const ws = await rowSocket();
    const legacy = await memberSocket();
    try {
      await waitFrame(legacy, (f) => f.type === "model_list");
      const before = ws.frames.length;
      const legacyBefore = legacy.frames.length;
      const res = await stack.env.app.inject({
        method: "POST",
        url: `/api/v1/threads/${chat.id}/turns`,
        headers: auth(stack.memberToken),
        payload: { model: "GLM-Test-Model", messages: [{ role: "user", content: "hello" }] },
      });
      expect(res.statusCode).toBe(200);
      const usage = await waitFrame(
        ws,
        (f) => f.type === "context_usage" && f.chat_id === chat.id && typeof f.tokens === "number",
        20_000,
      );
      expect(typeof usage.usage_model).toBe("string");
      await waitFrame(ws, (f) => f.type === "chat_status" && f.chat_id === chat.id && f.generating === false);
      // The list row settles with the turn: spinner off, unread dot on.
      await waitFrame(
        ws,
        (f) => f.type === "chat_row" && (f.chat as { id: string }).id === chat.id
          && (f.chat as { unread: boolean; generating: boolean }).unread
          && !(f.chat as { generating: boolean }).generating,
      );
      // Trailing pushes (the run's last commit, the generating flip) land.
      await new Promise((resolve) => setTimeout(resolve, 500));

      const turn = textFrames(ws).slice(before);
      const kinds = turn.map((f) => f.type as string);
      expect(kinds.filter((kind) => WORKSPACE_FRAMES.has(kind))).toEqual([]);
      const rows = turn.filter((f) => f.type === "chat_row");
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(6);
      expect(rows.every((f) => (f.chat as { id: string }).id === chat.id)).toBe(true);

      // A client without chat_row gets the list, and only the list.
      const legacyKinds = textFrames(legacy).slice(legacyBefore).map((f) => f.type as string);
      expect(legacyKinds).toContain("thread_list");
      expect(legacyKinds.filter((kind) => WORKSPACE_FRAMES.has(kind) && kind !== "thread_list")).toEqual([]);
    } finally {
      ws.end();
      legacy.end();
    }
  });

  it("carries the chat's context usage inside its sync bracket", { timeout: TEST_TIMEOUT }, async () => {
    const chat = await createChat("usage sync");
    const ws = await rowSocket();
    try {
      ws.send(JSON.stringify({ type: "sync", chat_id: chat.id }));
      await waitFrame(ws, (f) => f.type === "sync_done" && f.chat_id === chat.id);
      const frames = textFrames(ws);
      const begin = frames.findIndex((f) => f.type === "sync_begin" && f.chat_id === chat.id);
      const usage = frames.findIndex((f) => f.type === "context_usage" && f.chat_id === chat.id);
      const done = frames.findIndex((f) => f.type === "sync_done" && f.chat_id === chat.id);
      expect(begin).toBeGreaterThan(-1);
      expect(usage).toBeGreaterThan(begin);
      expect(usage).toBeLessThan(done);
      expect(frames[usage]).toEqual({
        type: "context_usage",
        chat_id: chat.id,
        tokens: null,
        usage_model: null,
        usage_model_alias: null,
      });
    } finally {
      ws.end();
    }
  });

  it("pushes compacting=false when a compaction ends without a summary", { timeout: TEST_TIMEOUT }, async () => {
    const chat = await createChat("no-op compaction");
    const ws = await rowSocket();
    try {
      // One short turn: the feed's last view of the chat reads
      // compacting=false, and there is nothing to compact.
      const turn = await stack.env.app.inject({
        method: "POST",
        url: `/api/v1/threads/${chat.id}/turns`,
        headers: auth(stack.memberToken),
        payload: { model: "GLM-Test-Model", messages: [{ role: "user", content: "short" }] },
      });
      expect(turn.statusCode).toBe(200);
      await waitFrame(
        ws,
        (f) => f.type === "thread_state" && f.chat_id === chat.id && f.generating === false
          && (f.events as { event: { type: string } }[]).some((e) => e.event.type === "assistant_message"),
        20_000,
      );
      const res = await stack.env.app.inject({
        method: "POST",
        url: `/api/v1/threads/${chat.id}/compact`,
        headers: auth(stack.memberToken),
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const started = JSON.parse(res.body) as { task_id: number | null; seq: number };
      expect(started.task_id).toBeGreaterThan(0);
      // The view already read compacting=false before the request: only the
      // settlement's forced republish can carry a newer state.
      const settled = await waitFrame(
        ws,
        (f) => f.type === "thread_state" && f.chat_id === chat.id && f.compacting === false
          && (f.seq as number) > started.seq,
      );
      expect(settled.generating).toBe(false);
    } finally {
      ws.end();
    }
  });
});

// A chat's view frames reach only the sockets that display it; list-level
// facts reach every socket of the owner. A compaction's writes coalesce
// into at most two views.
describe("member-socket view routing", () => {
  const VIEW_FRAMES = new Set(["thread_state", "thread_events", "live_frame", "context_usage"]);

  /** A member socket that displays `chatId` (null: a page with no chat). */
  async function viewing(chatId: string | null): Promise<ScriptedClient> {
    const ws = await memberSocket();
    await waitFrame(ws, (f) => f.type === "model_list");
    ws.send(JSON.stringify({ type: "sync", chat_id: chatId }));
    if (chatId !== null) await waitFrame(ws, (f) => f.type === "sync_done" && f.chat_id === chatId);
    else await new Promise((resolve) => setTimeout(resolve, 200));
    return ws;
  }

  const viewFramesOf = (ws: ScriptedClient, from: number, chatId: string) =>
    ws.frames
      .slice(from)
      .filter((f): f is { kind: "text"; data: string } => f.kind === "text")
      .map((f) => JSON.parse(f.data) as Record<string, unknown>)
      .filter((f) => VIEW_FRAMES.has(f.type as string) && f.chat_id === chatId);

  it("sends a chat's view only to the sockets showing it, and its status to all", { timeout: TEST_TIMEOUT }, async () => {
    const shown = await createChat("routed view");
    const other = await createChat("routed other");
    const onChat = await viewing(shown.id);
    const onOther = await viewing(other.id);
    const onNothing = await viewing(null);
    try {
      const marks = [onChat, onOther, onNothing].map((ws) => ws.frames.length);
      const res = await stack.env.app.inject({
        method: "POST",
        url: `/api/v1/threads/${shown.id}/turns`,
        headers: auth(stack.memberToken),
        payload: { model: "GLM-Test-Model", messages: [{ role: "user", content: "hello" }] },
      });
      expect(res.statusCode).toBe(200);
      await waitFrame(
        onChat,
        (f) => f.type === "thread_state" && f.chat_id === shown.id && f.generating === false
          && (f.events as { event: { type: string } }[]).some((e) => e.event.type === "assistant_message"),
        20_000,
      );
      // The spinner flip is a sidebar fact: every socket sees it.
      for (const ws of [onOther, onNothing]) {
        await waitFrame(ws, (f) => f.type === "chat_status" && f.chat_id === shown.id && f.generating === false);
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(viewFramesOf(onOther, marks[1]!, shown.id)).toEqual([]);
      expect(viewFramesOf(onNothing, marks[2]!, shown.id)).toEqual([]);

      // Opening the chat moves the socket's view: the next write reaches it.
      onOther.send(JSON.stringify({ type: "sync", chat_id: shown.id }));
      await waitFrame(onOther, (f) => f.type === "sync_done" && f.chat_id === shown.id);
      const appended = await stack.env.app.inject({
        method: "POST",
        url: `/api/v1/chats/${shown.id}/thread`,
        headers: auth(stack.memberToken),
        payload: { type: "system_message", content: "after the switch" },
      });
      expect(appended.statusCode).toBe(200);
      for (const ws of [onChat, onOther]) {
        await waitFrame(
          ws,
          (f) => f.type === "thread_state" && f.chat_id === shown.id
            && (f.events as { event: { type: string; content?: string } }[])
              .some((e) => e.event.type === "system_message" && e.event.content === "after the switch"),
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(viewFramesOf(onNothing, marks[2]!, shown.id)).toEqual([]);
    } finally {
      onChat.end();
      onOther.end();
      onNothing.end();
    }
  });

  /** The thread_state frames of one chat a socket received from `from`. */
  const statesOf = (ws: ScriptedClient, from: number, chatId: string) =>
    viewFramesOf(ws, from, chatId).filter((f) => f.type === "thread_state");

  it("a no-op compaction sends at most two views and lowers the line", { timeout: TEST_TIMEOUT }, async () => {
    const chat = await createChat("coalesced no-op");
    const ws = await viewing(chat.id);
    try {
      const turn = await stack.env.app.inject({
        method: "POST",
        url: `/api/v1/threads/${chat.id}/turns`,
        headers: auth(stack.memberToken),
        payload: { model: "GLM-Test-Model", messages: [{ role: "user", content: "short" }] },
      });
      expect(turn.statusCode).toBe(200);
      await waitFrame(
        ws,
        (f) => f.type === "thread_state" && f.chat_id === chat.id && f.generating === false
          && (f.events as { event: { type: string } }[]).some((e) => e.event.type === "assistant_message"),
        20_000,
      );
      await new Promise((resolve) => setTimeout(resolve, 500));
      const mark = ws.frames.length;
      const res = await stack.env.app.inject({
        method: "POST",
        url: `/api/v1/threads/${chat.id}/compact`,
        headers: auth(stack.memberToken),
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const started = JSON.parse(res.body) as { seq: number };
      await waitFrame(
        ws,
        (f) => f.type === "thread_state" && f.chat_id === chat.id && f.compacting === false
          && (f.seq as number) > started.seq,
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      const states = statesOf(ws, mark, chat.id);
      expect(states.length).toBeGreaterThanOrEqual(1);
      expect(states.length).toBeLessThanOrEqual(2);
      expect(states[states.length - 1]!.compacting).toBe(false);
    } finally {
      ws.end();
    }
  });

  it("a compaction that writes a summary sends at most two views", { timeout: TEST_TIMEOUT }, async () => {
    const created = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/threads",
      headers: auth(stack.memberToken),
      payload: { title: "coalesced compaction" },
    });
    const id = (JSON.parse(created.body) as { id: string }).id;
    const runtime = platform.runtime;
    await runtime.refreshOrgModels(stack.orgId);
    const conversation = await runtime.conversationForChat(id);
    await conversation.configure(
      { model: { provider: guildProviderId(stack.orgId), modelId: "GLM-Test-Model" } },
      BACKGROUND_CONTEXT,
    );
    await conversation.commit(async (tx) => {
      for (let i = 0; i < 3; i++) {
        await tx.appendEntry(UserEntry, conversation.id, {
          model: [{ role: "user", content: `${i}:` + "old context ".repeat(5000), timestamp: i }],
        });
      }
    }, BACKGROUND_CONTEXT);
    stack.mock.setResponses([
      {
        body:
          `data: ${JSON.stringify({ choices: [{ delta: { content: "summarized old context" } }] })}\n\n` +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
          "data: [DONE]\n\n",
      },
    ]);
    const ws = await viewing(id);
    try {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const mark = ws.frames.length;
      const res = await stack.env.app.inject({
        method: "POST",
        url: `/api/v1/threads/${id}/compact`,
        headers: auth(stack.memberToken),
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      const taskId = (JSON.parse(res.body) as { task_id: number }).task_id;
      await eventually(async () => {
        const status = await stack.env.app.inject({
          method: "GET",
          url: `/api/v1/threads/${id}/compactions/${taskId}`,
          headers: auth(stack.memberToken),
        });
        return (JSON.parse(status.body) as { status: string }).status === "completed";
      }, 20_000);
      await waitFrame(ws, (f) => f.type === "thread_state" && f.chat_id === id && f.compacting === false
        && (f.events as { event: { type: string } }[]).length > 0);
      await new Promise((resolve) => setTimeout(resolve, 600));
      const states = statesOf(ws, mark, id);
      expect(states.length).toBeGreaterThanOrEqual(1);
      expect(states.length).toBeLessThanOrEqual(2);
      expect(states[states.length - 1]!.compacting).toBe(false);
    } finally {
      ws.end();
    }
  });
});

// The per-chat caches follow the connected owners: a chat whose owner has
// no socket loses its cached tree and view, the identity cache is bounded,
// and a failed push is logged with its channel and chat.
interface Internals {
  chats: Map<string, unknown>;
  subagentTrees: Map<string, string>;
}

function fakeContext(options: { failQueries?: boolean } = {}) {
  const connected = new Set<string>();
  const frames: { userId: string; frame: unknown }[] = [];
  let handler: NotifyHandler | null = null;
  const ownerOf = (chatId: string) => `owner-${chatId}`;
  const ctx = {
    notify: {
      subscribe: (h: NotifyHandler) => {
        handler = h;
        return () => {};
      },
    },
    hub: {
      sinksOfUser: (userId: string) =>
        connected.has(userId) ? [{ send: (frame: unknown) => frames.push({ userId, frame }) }] : [],
      sinksOfOrg: () => [],
      memberSinksOfUser: () => [],
    },
    pool: {
      query: async (sql: string, params: unknown[]) => {
        if (options.failQueries) throw new Error("db down");
        if (sql.includes("FROM chats WHERE id")) {
          const chatId = String(params[0]);
          return { rows: [{ org_id: "org", user_id: ownerOf(chatId), machine_id: null }] };
        }
        return { rows: [] };
      },
    },
    chats: {
      identityOf: async (chatId: string) => {
        if (options.failQueries) throw new Error("db down");
        return { org_id: "org", user_id: ownerOf(chatId), machine_id: null };
      },
      lastEventSeq: async () => {
        if (options.failQueries) throw new Error("db down");
        return null;
      },
    },
    threads: {
      lastEventType: async () => undefined,
    },
  };
  return {
    ctx: ctx as unknown as FeedDeps,
    connected,
    frames,
    ownerOf,
    notify: (channel: string, payload: string) => handler!(channel, payload),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("feed forwarder caches", () => {
  it("evicts a chat's cached tree once its owner has no socket", async () => {
    const fake = fakeContext();
    const feed = new FeedForwarder(fake.ctx);
    feed.start();
    const internals = feed as unknown as Internals;
    fake.connected.add(fake.ownerOf("a"));
    fake.connected.add(fake.ownerOf("b"));
    fake.notify("guild_subagent_tree", "a");
    fake.notify("guild_subagent_tree", "b");
    await settle();
    expect([...internals.subagentTrees.keys()].sort()).toEqual(["a", "b"]);
    // Each chat gets its subtree and its header facts.
    const types = fake.frames.map(({ frame }) => (frame as { type: string }).type).sort();
    expect(types).toEqual(["chat_tree", "chat_tree", "subagent_tree", "subagent_tree"]);

    fake.connected.delete(fake.ownerOf("a"));
    feed.sweep();
    expect([...internals.subagentTrees.keys()]).toEqual(["b"]);

    // A later tree change for an unwatched chat caches nothing.
    fake.notify("guild_subagent_tree", "a");
    await settle();
    expect(internals.subagentTrees.has("a")).toBe(false);
    feed.stop();
  });

  it("bounds the chat identity cache", async () => {
    const fake = fakeContext();
    const feed = new FeedForwarder(fake.ctx);
    feed.start();
    for (let index = 0; index < 4_200; index += 1) feed.open(`c${index}`, `g${index}`);
    await settle();
    const chats = (feed as unknown as Internals).chats;
    expect(chats.size).toBe(4_096);
    expect(chats.has("c0")).toBe(false);
    expect(chats.has("c4199")).toBe(true);
    feed.stop();
  });

  it("logs a failed push with its channel and chat id", async () => {
    const fake = fakeContext({ failQueries: true });
    const warnings: { channel: string; key: string | null }[] = [];
    const feed = new FeedForwarder(fake.ctx, {
      warn: ((fields: { channel: string; key: string | null }) => {
        warnings.push({ channel: fields.channel, key: fields.key });
      }) as never,
    });
    feed.start();
    fake.notify("guild_thread_committed", "chat-1");
    fake.notify("guild_subagent_tree", "chat-2");
    feed.open("chat-3", "gen-1");
    await settle();
    expect(warnings).toEqual(
      expect.arrayContaining([
        { channel: "guild_thread_committed", key: "chat-1" },
        { channel: "guild_subagent_tree", key: "chat-2" },
        { channel: "open", key: "chat-3" },
      ]),
    );
    feed.stop();
  });
});
