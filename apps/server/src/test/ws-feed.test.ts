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
import type { PlatformContext } from "../platform/root-context.js";

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

/** A second member user + live session token (org-scoped stranger). */
async function strangerToken(email: string): Promise<string> {
  const token = crypto.randomBytes(24).toString("hex");
  await stack.env.db.query(
    `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
     VALUES (gen_random_uuid(), $1, $2, '', 'member', 'managed')`,
    [stack.orgId, email],
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
      `INSERT INTO agent_threads (id, agent_id, chat_id, title, kind, user_id, depth)
       VALUES ($1, $2, $3, 'Child thread', 'delegated', $4, 1)`,
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
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, kind)
       VALUES ($1, $2, $3, $4, 'Root session', 'thread')`,
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
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, kind, parent_thread_id, depth)
       VALUES ($1, $2, $3, $4, 'Child session', 'delegated', $5, 1)`,
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

    const pushed = await waitFrame(
      ws,
      (f) => f.type === "subagent_tree" && f.chat_id === chat.id
        && (f.nodes as unknown[]).length === 2,
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
});
