// Agent and skill state on the member socket: every write to an agent, a
// run, a routine, a thread or the skill catalog reaches the sockets allowed
// to read it as a whole-value frame, and nobody else's. The chat header's
// tree facts ride the chat's sync bracket and follow later changes.

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import crypto from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setupGatewayStack, type GatewayStack } from "./support/gateway-stack.js";
import { ScriptedClient } from "./platform/ws-driver.js";
import type { PlatformContext } from "../composition.js";
import { AgentStateFeed, BURST_MAX_MS, BURST_QUIET_MS, type AgentStateDeps } from "../hub/agent-state.js";

const TEST_TIMEOUT = 30_000;

let stack: GatewayStack;
let base: string;

beforeAll(async () => {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  stack = await setupGatewayStack(
    { GUILD_SELF_BASE_URL: `http://127.0.0.1:${port}` },
    { dbPrefix: "guild_agent_state_test_" },
  );
  await stack.env.app.listen({ port, host: "127.0.0.1" });
  base = `http://127.0.0.1:${port}`;
  await stack.routeModel("GLM-Test-Model");
}, 60_000);

afterAll(async () => {
  await stack.close();
}, 30_000);

type Frame = Record<string, unknown>;

const auth = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

async function api<T>(
  token: string,
  method: "GET" | "POST" | "PATCH",
  url: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  const res = await stack.env.app.inject({
    method,
    url,
    headers: auth(token),
    ...(payload !== undefined ? { payload } : {}),
  });
  expect(res.statusCode, res.body).toBe(200);
  return JSON.parse(res.body) as T;
}

/** A second org member with a live session token. */
async function memberToken(email: string): Promise<{ token: string; id: string }> {
  const token = crypto.randomBytes(24).toString("hex");
  const user = await stack.env.db.query<{ id: string }>(
    `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
     VALUES (gen_random_uuid(), $1, $2, '', 'member', 'managed') RETURNING id`,
    [stack.orgId, email],
  );
  await stack.env.db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at, auth_generation)
     SELECT $1, id, now() + interval '1 day', auth_generation FROM users WHERE email = $2`,
    [crypto.createHash("sha256").update(token).digest("hex"), email],
  );
  return { token, id: user.rows[0]!.id };
}

/** A connected member socket, past its first agent list and skill catalog. */
async function memberSocket(token: string): Promise<ScriptedClient> {
  const res = await stack.env.app.inject({
    method: "POST",
    url: "/api/v1/ws/ticket",
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  const ticket = (JSON.parse(res.body) as { ticket: string }).ticket;
  const ws = new ScriptedClient(base, `ticket=${ticket}&client_id=${crypto.randomUUID()}`);
  await ws.open();
  await waitFrame(ws, (f) => f.type === "agent_list");
  await waitFrame(ws, (f) => f.type === "skill_catalog");
  return ws;
}

function textFrames(ws: ScriptedClient): Frame[] {
  return ws.frames
    .filter((f): f is { kind: "text"; data: string } => f.kind === "text")
    .map((f) => JSON.parse(f.data) as Frame);
}

async function waitFrame(ws: ScriptedClient, predicate: (frame: Frame) => boolean, timeoutMs = 15_000): Promise<Frame> {
  const found = await ws.until((f) => {
    if (f.kind !== "text") return false;
    try {
      return predicate(JSON.parse(f.data) as Frame);
    } catch {
      return false;
    }
  }, timeoutMs);
  return JSON.parse((found as { data: string }).data) as Frame;
}

const agentsOf = (frame: Frame) => frame.agents as { id: string; name: string; is_personal: boolean }[];

async function createAgent(token: string, name: string, visibility: "private" | "org"): Promise<string> {
  const body = await api<{ agent: { id: string } }>(token, "POST", "/api/v1/agents", {
    name,
    model: "GLM-Test-Model",
    visibility,
  });
  return body.agent.id;
}

async function insertRun(
  agentId: string,
  userId: string,
  status: string,
  threadId: string | null = null,
): Promise<string> {
  const runId = crypto.randomUUID();
  await stack.env.db.query(
    `INSERT INTO agent_runs (id, agent_id, user_id, trigger, status, started_at, thread_id)
     VALUES ($1, $2, $3, 'manual', $4, now(), $5)`,
    [runId, agentId, userId, status, threadId],
  );
  return runId;
}

describe("agent and skill state frames", () => {
  it("paints the agent list and skill catalog on connect, personal agent included", {
    timeout: TEST_TIMEOUT,
  }, async () => {
    const ws = await memberSocket(stack.memberToken);
    try {
      const list = textFrames(ws).find((f) => f.type === "agent_list")!;
      expect(agentsOf(list).some((a) => a.is_personal)).toBe(true);
      const catalog = textFrames(ws).find((f) => f.type === "skill_catalog")!;
      expect(Array.isArray(catalog.items)).toBe(true);
      expect(Array.isArray(catalog.installs)).toBe(true);
    } finally {
      ws.end();
    }
  });

  it("scopes agent lists and runs to the members who may see the agent", { timeout: TEST_TIMEOUT }, async () => {
    const other = await memberToken(`agent-state-${crypto.randomUUID()}@example.test`);
    const owner = await memberSocket(stack.memberToken);
    const peer = await memberSocket(other.token);
    try {
      const privateId = await createAgent(stack.memberToken, `private-${crypto.randomUUID().slice(0, 8)}`, "private");
      await waitFrame(owner, (f) => f.type === "agent_list" && agentsOf(f).some((a) => a.id === privateId));
      const shared = await createAgent(stack.memberToken, `shared-${crypto.randomUUID().slice(0, 8)}`, "org");
      await waitFrame(peer, (f) => f.type === "agent_list" && agentsOf(f).some((a) => a.id === shared));
      expect(textFrames(peer).some((f) => f.type === "agent_list" && agentsOf(f).some((a) => a.id === privateId))).toBe(
        false,
      );

      // A run on the private agent reaches its owner only; a run on the
      // shared one still reaches only its requesting member.
      const privateRun = await insertRun(privateId, stack.memberId, "running");
      await waitFrame(owner, (f) => f.type === "agent_run" && (f.run as { id: string }).id === privateRun);
      const sharedRun = await insertRun(shared, stack.memberId, "running");
      await waitFrame(owner, (f) => f.type === "agent_run" && (f.run as { id: string }).id === sharedRun);
      await stack.env.db.query("UPDATE agent_runs SET status = 'succeeded', finished_at = now() WHERE id = $1", [
        sharedRun,
      ]);
      const finished = await waitFrame(
        owner,
        (f) =>
          f.type === "agent_run" &&
          (f.run as { id: string; status: string }).id === sharedRun &&
          (f.run as { status: string }).status === "succeeded",
      );
      expect((finished.run as { finished_at: string | null }).finished_at).not.toBeNull();
      expect(textFrames(peer).some((f) => f.type === "agent_run" && (f.run as { id: string }).id === sharedRun)).toBe(
        false,
      );
      expect(textFrames(peer).some((f) => f.type === "agent_run" && (f.run as { id: string }).id === privateRun)).toBe(
        false,
      );
    } finally {
      owner.end();
      peer.end();
    }
  });

  it("pushes org-wide Activity updates to admins while keeping background Runs out of Member and Agent feeds", async () => {
    const admin = await memberSocket(stack.adminToken);
    const owner = await memberSocket(stack.memberToken);
    const idleAdmin = await memberSocket(stack.adminToken);
    try {
      const agentId = await createAgent(stack.memberToken, `activity-${crypto.randomUUID().slice(0, 8)}`, "private");
      const { thread } = await api<{ thread: { id: string; chat_id: string } }>(
        stack.memberToken,
        "POST",
        `/api/v1/agents/${agentId}/threads`,
        {},
      );
      const ordinaryRun = await insertRun(agentId, stack.memberId, "running");
      const isRun = (frame: Frame, id: string) => (frame.run as { id: string } | undefined)?.id === id;
      await waitFrame(admin, (frame) => frame.type === "activity_run" && isRun(frame, ordinaryRun));
      await waitFrame(owner, (frame) => frame.type === "activity_run" && isRun(frame, ordinaryRun));

      await stack.env.db.query("UPDATE chats SET internal = true WHERE id = $1", [thread.chat_id]);
      const internalRun = await insertRun(agentId, stack.memberId, "running", thread.id);
      const running = await waitFrame(admin, (frame) => frame.type === "activity_run" && isRun(frame, internalRun));
      expect(running.run).toMatchObject({ internal: true, status: "running" });
      expect(running.counts).toEqual({ runs: 1, open_runs: 1, failed_runs: 0 });
      for (const socket of [admin, owner]) socket.send(JSON.stringify({ type: "sync", run_id: internalRun }));
      await waitFrame(admin, (frame) => isRun(frame, internalRun) && Array.isArray(frame.steps));
      await stack.env.app.platform.threads.appendEvent(thread.chat_id, {
        type: "user_message",
        content: "Durable background request",
        attachments: [],
      });
      await waitFrame(
        admin,
        (frame) =>
          isRun(frame, internalRun) &&
          (frame.steps as unknown[] | undefined)?.some(
            (step) => (step as { detail: string }).detail === "Durable background request",
          ) === true,
      );
      await idleAdmin.pingBarrier();
      expect(textFrames(idleAdmin).some((frame) => isRun(frame, internalRun) && frame.steps !== undefined)).toBe(false);

      await stack.env.db.query("UPDATE agent_runs SET status = 'failed', finished_at = now() WHERE id = $1", [
        internalRun,
      ]);
      const finished = await waitFrame(
        admin,
        (frame) =>
          frame.type === "activity_run" &&
          isRun(frame, internalRun) &&
          (frame.run as { status: string }).status === "failed",
      );
      expect(finished.counts).toEqual({ runs: 1, open_runs: 0, failed_runs: 1 });
      await owner.pingBarrier();
      expect(textFrames(owner).some((frame) => isRun(frame, internalRun))).toBe(false);
      expect(textFrames(admin).some((frame) => frame.type === "agent_run" && isRun(frame, ordinaryRun))).toBe(false);
      const unavailable = (frame: Frame) => frame.type === "activity_run_unavailable" && frame.run_id === internalRun;
      await stack.env.db.query("UPDATE users SET role = 'member' WHERE id = $1", [stack.adminId]);
      try {
        await waitFrame(admin, unavailable);
        expect(textFrames(idleAdmin).some(unavailable)).toBe(false);
        const reconnected = await memberSocket(stack.adminToken);
        try {
          reconnected.send(JSON.stringify({ type: "sync", run_id: internalRun }));
          await waitFrame(reconnected, unavailable);
          expect(textFrames(reconnected).some((frame) => isRun(frame, internalRun))).toBe(false);
          reconnected.send(JSON.stringify({ type: "sync", run_id: ordinaryRun }));
          await waitFrame(
            reconnected,
            (frame) => frame.type === "activity_run_unavailable" && frame.run_id === ordinaryRun,
          );
        } finally {
          reconnected.end();
        }
      } finally {
        await stack.env.db.query("UPDATE users SET role = 'admin' WHERE id = $1", [stack.adminId]);
      }
      await waitFrame(admin, (frame) => isRun(frame, internalRun) && Array.isArray(frame.steps));
      admin.send(JSON.stringify({ type: "sync", run_id: ordinaryRun }));
      await waitFrame(admin, (frame) => isRun(frame, ordinaryRun) && Array.isArray(frame.steps));

      // Commit a role change with its NOTIFY missing, then invoke the same
      // resync callback a recovered LISTEN connection calls.
      const db = await stack.env.db.connect();
      try {
        await db.query("BEGIN");
        await db.query("ALTER TABLE users DISABLE TRIGGER users_profile_notify");
        await db.query("UPDATE users SET role = 'member' WHERE id = $1", [stack.adminId]);
        await db.query("ALTER TABLE users ENABLE TRIGGER users_profile_notify");
        await db.query("COMMIT");
        stack.env.app.platform.feed["resync"]();
        await waitFrame(admin, (frame) => frame.type === "activity_run_unavailable" && frame.run_id === ordinaryRun);
      } finally {
        await db.query("ROLLBACK");
        db.release();
        await stack.env.db.query("UPDATE users SET role = 'admin' WHERE id = $1", [stack.adminId]);
      }
    } finally {
      admin.end();
      idleAdmin.end();
      owner.end();
    }
  });

  it("watches authorized background Conversations and seeds missed changes on a new socket", async () => {
    const admin = await memberSocket(stack.adminToken);
    const owner = await memberSocket(stack.memberToken);
    const idleAdmin = await memberSocket(stack.adminToken);
    let reconnected: ScriptedClient | undefined;
    try {
      const agentId = await createAgent(stack.memberToken, `dialogue-${crypto.randomUUID().slice(0, 8)}`, "private");
      const { thread } = await api<{ thread: { id: string; chat_id: string } }>(
        stack.memberToken,
        "POST",
        `/api/v1/agents/${agentId}/threads`,
        {},
      );
      await stack.env.db.query("UPDATE chats SET internal = true WHERE id = $1", [thread.chat_id]);
      const runId = await insertRun(agentId, stack.memberId, "running", thread.id);
      const watch = JSON.stringify({ type: "sync", activity_chat_id: thread.chat_id });
      admin.send(watch);
      owner.send(watch);
      const watched = (frame: Frame) => frame.type === "activity_conversation" && frame.chat_id === thread.chat_id;
      const selected = (frame: Frame) => watched(frame) && frame.detail !== null;
      const forbidden = await waitFrame(owner, (frame) => watched(frame) && frame.detail === null);
      const seeded = await waitFrame(admin, selected);
      expect(seeded.detail).toMatchObject({ conversation: { internal: true, open_runs: 1 } });

      await stack.env.app.platform.threads.appendEvent(thread.chat_id, {
        type: "user_message",
        content: "A saved background message",
        attachments: [],
      });
      const changed = await waitFrame(
        admin,
        (frame) => selected(frame) && JSON.stringify(frame.detail).includes("A saved background message"),
      );
      expect(changed.detail).toMatchObject({
        items: expect.arrayContaining([
          expect.objectContaining({ kind: "message", text: "A saved background message" }),
        ]),
      });
      await owner.pingBarrier();
      await idleAdmin.pingBarrier();
      expect(textFrames(owner).some(selected)).toBe(false);
      expect(textFrames(idleAdmin).some(selected)).toBe(false);

      const child = await stack.env.app.platform.agents.threads.createChildThread(
        thread.id,
        agentId,
        stack.memberId,
        "A related task",
      );
      const relation = await waitFrame(
        admin,
        (frame) =>
          selected(frame) &&
          (frame.detail as { related_threads: { id: string }[] }).related_threads.some(
            ({ id }) => id === child.chat_id,
          ),
      );
      expect(relation.detail).toMatchObject({ related_threads: [{ id: child.chat_id, title: "A related task" }] });

      await stack.env.db.query("UPDATE chats SET title=$2, archived_at=now() WHERE id=$1", [
        thread.chat_id,
        "Renamed background conversation",
      ]);
      const metadata = await waitFrame(
        admin,
        (frame) =>
          selected(frame) &&
          (frame.detail as { conversation: { title: string } }).conversation.title ===
            "Renamed background conversation",
      );
      expect(metadata.detail).toMatchObject({ conversation: { archived: true } });
      await owner.pingBarrier();
      await idleAdmin.pingBarrier();
      expect(textFrames(owner).some(selected)).toBe(false);
      expect(textFrames(idleAdmin).some(selected)).toBe(false);

      admin.end();
      await stack.env.db.query("UPDATE agent_runs SET status='failed', finished_at=now() WHERE id=$1", [runId]);
      await stack.env.app.platform.threads.appendEvent(thread.chat_id, {
        type: "user_message",
        content: "A message committed while disconnected",
        attachments: [],
      });
      reconnected = await memberSocket(stack.adminToken);
      reconnected.send(watch);
      const afterReconnect = await waitFrame(reconnected, selected);
      expect(afterReconnect.detail).toMatchObject({ conversation: { open_runs: 0, failed_runs: 1 } });
      expect(JSON.stringify(afterReconnect.detail)).toContain("A message committed while disconnected");
      expect(JSON.stringify(afterReconnect.detail)).toContain('"status":"failed"');
      const original = await stack.env.app.platform.identity.getUser(stack.memberId);
      try {
        await stack.env.db.query("UPDATE users SET display_name=$2, email=$3 WHERE id=$1", [
          stack.memberId,
          "Conversation owner",
          "conversation-owner@example.test",
        ]);
        const renamedOwner = await waitFrame(
          reconnected,
          (frame) =>
            selected(frame) &&
            (frame.detail as { conversation: { owner: { display_name: string } } }).conversation.owner.display_name ===
              "Conversation owner",
        );
        expect(renamedOwner.detail).toMatchObject({
          conversation: { owner: { email: "conversation-owner@example.test" } },
        });
      } finally {
        await stack.env.db.query("UPDATE users SET display_name=$2, email=$3 WHERE id=$1", [
          stack.memberId,
          original.display_name,
          original.email,
        ]);
      }
      expect(textFrames(idleAdmin).some(watched)).toBe(false);

      await stack.env.app.platform.agents.lifecycle.purgeById(stack.orgId, agentId);
      const purged = await waitFrame(reconnected, (frame) => watched(frame) && frame.detail === null);
      expect(purged).toEqual(forbidden);
    } finally {
      admin.end();
      owner.end();
      idleAdmin.end();
      reconnected?.end();
    }
  });

  it("carries a finished run's call and tool counts", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await memberSocket(stack.memberToken);
    try {
      const agentId = await createAgent(stack.memberToken, `counted-${crypto.randomUUID().slice(0, 8)}`, "private");
      const runId = await insertRun(agentId, stack.memberId, "running");
      const running = await waitFrame(owner, (f) => f.type === "agent_run" && (f.run as { id: string }).id === runId);
      expect(running.run).not.toHaveProperty("call_count");
      const platform = (stack.env.app as unknown as { platform: PlatformContext }).platform;
      const spans: ("llm" | "tool")[] = ["llm", "tool", "llm", "llm"];
      for (const [index, spanType] of spans.entries()) {
        await platform.trace.recordSpan({
          span_id: crypto.randomUUID(),
          trace_id: runId,
          run_id: runId,
          org_id: stack.orgId,
          name: `${spanType}-${index}`,
          span_type: spanType,
          start_time: new Date(),
        });
      }
      await stack.env.db.query("UPDATE agent_runs SET status = 'succeeded', finished_at = now() WHERE id = $1", [
        runId,
      ]);
      const finished = await waitFrame(
        owner,
        (f) =>
          f.type === "agent_run" &&
          (f.run as { id: string; status: string }).id === runId &&
          (f.run as { status: string }).status === "succeeded",
      );
      expect(finished.run).toMatchObject({ call_count: 3, tool_count: 1 });
    } finally {
      owner.end();
    }
  });

  it("pushes an agent's routines to its viewers and a thread list to its owner", {
    timeout: TEST_TIMEOUT,
  }, async () => {
    const other = await memberToken(`agent-routines-${crypto.randomUUID()}@example.test`);
    const owner = await memberSocket(stack.memberToken);
    const peer = await memberSocket(other.token);
    try {
      const agentId = await createAgent(stack.memberToken, `routines-${crypto.randomUUID().slice(0, 8)}`, "org");
      const routine = await api<{ routine: { id: string } }>(
        stack.memberToken,
        "POST",
        `/api/v1/agents/${agentId}/routines`,
        {
          name: "Morning digest",
          kind: "cron",
          schedule: "0 9 * * 1-5",
          timezone: "UTC",
          prompt: "Summarize yesterday.",
        },
      );
      for (const ws of [owner, peer]) {
        const frame = await waitFrame(
          ws,
          (f) =>
            f.type === "agent_routines" &&
            f.agent_id === agentId &&
            (f.routines as { id: string }[]).some((r) => r.id === routine.routine.id),
        );
        expect((frame.routines as { name: string }[])[0]!.name).toBe("Morning digest");
      }

      const thread = await api<{ thread: { id: string } }>(
        stack.memberToken,
        "POST",
        `/api/v1/agents/${agentId}/threads`,
        {
          title: "Planning",
        },
      );
      await waitFrame(
        owner,
        (f) =>
          f.type === "agent_threads" &&
          f.agent_id === agentId &&
          (f.threads as { id: string }[]).some((t) => t.id === thread.thread.id),
      );
      await api(stack.memberToken, "PATCH", `/api/v1/agents/${agentId}/threads/${thread.thread.id}`, {
        title: "Renamed plan",
      });
      await waitFrame(
        owner,
        (f) =>
          f.type === "agent_threads" &&
          f.agent_id === agentId &&
          (f.threads as { id: string; title: string }[]).some(
            (t) => t.id === thread.thread.id && t.title === "Renamed plan",
          ),
      );
      expect(textFrames(peer).some((f) => f.type === "agent_threads" && f.agent_id === agentId)).toBe(false);
    } finally {
      owner.end();
      peer.end();
    }
  });

  it("pushes the skill catalog to every member when the registry changes", { timeout: TEST_TIMEOUT }, async () => {
    const other = await memberToken(`skills-${crypto.randomUUID()}@example.test`);
    const owner = await memberSocket(stack.memberToken);
    const peer = await memberSocket(other.token);
    const slug = `skill-${crypto.randomUUID().slice(0, 8)}`;
    try {
      await stack.env.db.query(
        `INSERT INTO registry_items (id, org_id, kind, slug, description, latest_version, owner_user_id)
         VALUES (gen_random_uuid(), $1, 'skill', $2, 'A pushed skill.', '1.0.0', $3)`,
        [stack.orgId, slug, stack.memberId],
      );
      for (const ws of [owner, peer]) {
        const frame = await waitFrame(
          ws,
          (f) => f.type === "skill_catalog" && (f.items as { slug: string }[]).some((i) => i.slug === slug),
        );
        const item = (frame.items as { slug: string; owner: { kind: string; id: string } | null }[]).find(
          (i) => i.slug === slug,
        )!;
        expect(item.owner).toMatchObject({ kind: "user", id: stack.memberId });
      }
      // An install moves the installer's own list; the peer's stays empty.
      await stack.env.db.query(
        `INSERT INTO skill_installs (id, org_id, user_id, slug, pinned_version) VALUES (gen_random_uuid(), $1, $2, $3, NULL)`,
        [stack.orgId, stack.memberId, slug],
      );
      await waitFrame(
        owner,
        (f) => f.type === "skill_catalog" && (f.installs as { slug: string }[]).some((i) => i.slug === slug),
      );
      const peerFrame = await waitFrame(
        peer,
        (f) =>
          f.type === "skill_catalog" &&
          (f.items as { slug: string; installs: number }[]).some((i) => i.slug === slug && i.installs === 1),
      );
      expect((peerFrame.installs as { slug: string }[]).some((i) => i.slug === slug)).toBe(false);
    } finally {
      owner.end();
      peer.end();
    }
  });

  it("carries the chat's tree facts in its sync bracket and pushes a rename", { timeout: TEST_TIMEOUT }, async () => {
    const agentId = await createAgent(stack.memberToken, `tree-${crypto.randomUUID().slice(0, 8)}`, "private");
    const thread = await api<{ thread: { id: string; chat_id: string } }>(
      stack.memberToken,
      "POST",
      `/api/v1/agents/${agentId}/threads`,
      {
        title: "Header facts",
      },
    );
    const chatId = thread.thread.chat_id;
    const ws = await memberSocket(stack.memberToken);
    try {
      ws.send(JSON.stringify({ type: "sync", chat_id: chatId }));
      await waitFrame(ws, (f) => f.type === "sync_done" && f.chat_id === chatId);
      const frames = textFrames(ws);
      const treeIndex = frames.findIndex((f) => f.type === "chat_tree" && f.chat_id === chatId);
      const stateIndex = frames.findIndex((f) => f.type === "thread_state" && f.chat_id === chatId);
      expect(treeIndex).toBeGreaterThan(-1);
      expect(treeIndex).toBeLessThan(stateIndex);
      expect(frames[treeIndex]!.tree).toMatchObject({
        chat_id: chatId,
        type: "user",
        title: "Header facts",
        agent_id: agentId,
      });

      await api(stack.memberToken, "PATCH", `/api/v1/agents/${agentId}/threads/${thread.thread.id}`, {
        title: "Renamed header",
      });
      await waitFrame(
        ws,
        (f) =>
          f.type === "chat_tree" && f.chat_id === chatId && (f.tree as { title: string }).title === "Renamed header",
      );
    } finally {
      ws.end();
    }
  });

  it("tells the reader whether it owns the chat", { timeout: TEST_TIMEOUT }, async () => {
    const agentId = await createAgent(stack.memberToken, `own-${crypto.randomUUID().slice(0, 8)}`, "private");
    const thread = await api<{ thread: { chat_id: string } }>(
      stack.memberToken,
      "POST",
      `/api/v1/agents/${agentId}/threads`,
      {
        title: "Whose chat",
      },
    );
    const chatId = thread.thread.chat_id;
    const syncTree = async (token: string): Promise<Frame> => {
      const ws = await memberSocket(token);
      try {
        ws.send(JSON.stringify({ type: "sync", chat_id: chatId }));
        return await waitFrame(ws, (f) => f.type === "chat_tree" && f.chat_id === chatId);
      } finally {
        ws.end();
      }
    };
    expect((await syncTree(stack.memberToken)).tree).toMatchObject({ chat_id: chatId, own: true });
    expect((await syncTree(stack.adminToken)).tree).toMatchObject({ chat_id: chatId, own: false });
    const adminRead = await api<{ own: boolean }>(stack.adminToken, "GET", `/api/v1/chats/${chatId}/tree`);
    expect(adminRead.own).toBe(false);
    const ownerRead = await api<{ own: boolean }>(stack.memberToken, "GET", `/api/v1/chats/${chatId}/tree`);
    expect(ownerRead.own).toBe(true);
  });

  it("re-pushes the tree of every chat that shows a renamed agent's thread", { timeout: TEST_TIMEOUT }, async () => {
    const agentId = await createAgent(stack.memberToken, `named-${crypto.randomUUID().slice(0, 8)}`, "private");
    const thread = await api<{ thread: { id: string; chat_id: string } }>(
      stack.memberToken,
      "POST",
      `/api/v1/agents/${agentId}/threads`,
      {
        title: "Rename root",
      },
    );
    const rootChat = thread.thread.chat_id;
    const childChat = await api<{ id: string }>(stack.memberToken, "POST", "/api/v1/chats", { title: "Rename child" });
    const childThread = crypto.randomUUID();
    await stack.env.db.query(
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, type, parent_thread_id, depth)
       VALUES ($1, $2, $3, $4, 'Rename child', 'subagent', $5, 1)`,
      [childThread, agentId, stack.memberId, childChat.id, thread.thread.id],
    );
    const ws = await memberSocket(stack.memberToken);
    try {
      ws.send(JSON.stringify({ type: "sync", chat_id: rootChat }));
      await waitFrame(ws, (f) => f.type === "sync_done" && f.chat_id === rootChat);
      ws.send(JSON.stringify({ type: "sync", chat_id: childChat.id }));
      await waitFrame(ws, (f) => f.type === "sync_done" && f.chat_id === childChat.id);

      await api(stack.memberToken, "PATCH", `/api/v1/agents/${agentId}`, { name: "Renamed agent" });

      const rootTree = await waitFrame(
        ws,
        (f) =>
          f.type === "chat_tree" &&
          f.chat_id === rootChat &&
          (f.tree as { agent_name: string }).agent_name === "Renamed agent",
      );
      expect(rootTree.tree).toMatchObject({ agent_id: agentId, own: true });
      const subtree = await waitFrame(
        ws,
        (f) =>
          f.type === "subagent_tree" &&
          f.chat_id === rootChat &&
          (f.nodes as { agent_name: string }[]).length === 2 &&
          (f.nodes as { agent_name: string }[]).every((n) => n.agent_name === "Renamed agent"),
      );
      expect((subtree.nodes as { thread_id: string }[]).map((n) => n.thread_id)).toEqual([
        thread.thread.id,
        childThread,
      ]);
      await waitFrame(
        ws,
        (f) =>
          f.type === "chat_tree" &&
          f.chat_id === childChat.id &&
          (f.tree as { agent_name: string }).agent_name === "Renamed agent",
      );
    } finally {
      ws.end();
    }
  });

  it("sends one skill catalog frame per user for one write burst", { timeout: TEST_TIMEOUT }, async () => {
    const owner = await memberSocket(stack.memberToken);
    const slug = `burst-${crypto.randomUUID().slice(0, 8)}`;
    try {
      const catalogs = () => textFrames(owner).filter((f) => f.type === "skill_catalog").length;
      const before = catalogs();
      // A publish's shape: the item row, then follow-up writes in their own
      // statements. The window's timing is covered with fake timers below.
      await stack.env.db.query(
        `INSERT INTO registry_items (id, org_id, kind, slug, description, latest_version, owner_user_id)
         VALUES (gen_random_uuid(), $1, 'skill', $2, 'A burst skill.', '1.0.0', $3)`,
        [stack.orgId, slug, stack.memberId],
      );
      await stack.env.db.query(
        "UPDATE registry_items SET description = 'A burst skill, described.' WHERE org_id = $1 AND slug = $2",
        [stack.orgId, slug],
      );
      await stack.env.db.query(
        `INSERT INTO skill_installs (id, org_id, user_id, slug, pinned_version) VALUES (gen_random_uuid(), $1, $2, $3, NULL)`,
        [stack.orgId, stack.memberId, slug],
      );
      await waitFrame(
        owner,
        (f) => f.type === "skill_catalog" && (f.installs as { slug: string }[]).some((i) => i.slug === slug),
      );
      // Every NOTIFY of the burst is handled and its push enqueued; the
      // socket's pong lands behind any second catalog.
      await stack.env.app.platform.feed.idle();
      await owner.pingBarrier();
      expect(catalogs()).toBe(before + 1);
    } finally {
      owner.end();
    }
  });

  it("sends no agent list to a member whose visible agents did not change", { timeout: TEST_TIMEOUT }, async () => {
    const other = await memberToken(`agent-quiet-${crypto.randomUUID()}@example.test`);
    const owner = await memberSocket(stack.memberToken);
    const peer = await memberSocket(other.token);
    try {
      const peerLists = () => textFrames(peer).filter((f) => f.type === "agent_list").length;
      const before = peerLists();
      const privateId = await createAgent(stack.memberToken, `quiet-${crypto.randomUUID().slice(0, 8)}`, "private");
      await waitFrame(owner, (f) => f.type === "agent_list" && agentsOf(f).some((a) => a.id === privateId));
      // The org's agent pushes run on one chain: once the shared agent
      // reaches the peer, the private write's push has already passed it.
      const shared = await createAgent(stack.memberToken, `loud-${crypto.randomUUID().slice(0, 8)}`, "org");
      await waitFrame(peer, (f) => f.type === "agent_list" && agentsOf(f).some((a) => a.id === shared));
      expect(peerLists()).toBe(before + 1);
    } finally {
      owner.end();
      peer.end();
    }
  });

  it("names a child's parent by the parent chat's title and follows its rename", {
    timeout: TEST_TIMEOUT,
  }, async () => {
    const agentId = await createAgent(stack.memberToken, `parent-${crypto.randomUUID().slice(0, 8)}`, "private");
    const thread = await api<{ thread: { id: string; chat_id: string } }>(
      stack.memberToken,
      "POST",
      `/api/v1/agents/${agentId}/threads`,
      {
        title: "Parent before",
      },
    );
    const rootChat = thread.thread.chat_id;
    const childChat = await api<{ id: string }>(stack.memberToken, "POST", "/api/v1/chats", { title: "Child chat" });
    const childThread = crypto.randomUUID();
    await stack.env.db.query(
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, type, parent_thread_id, depth)
       VALUES ($1, $2, $3, $4, 'Child chat', 'subagent', $5, 1)`,
      [childThread, agentId, stack.memberId, childChat.id, thread.thread.id],
    );
    const ws = await memberSocket(stack.memberToken);
    try {
      ws.send(JSON.stringify({ type: "sync", chat_id: childChat.id }));
      const synced = await waitFrame(ws, (f) => f.type === "chat_tree" && f.chat_id === childChat.id);
      expect((synced.tree as { parent: { chat_id: string; title: string } }).parent).toEqual({
        chat_id: rootChat,
        title: "Parent before",
      });

      // A chat rename writes the chat's title alone; the child's header and
      // the parent's own header name it by that title.
      await api(stack.memberToken, "PATCH", `/api/v1/threads/${rootChat}`, { title: "Parent after" });
      await waitFrame(
        ws,
        (f) =>
          f.type === "chat_tree" &&
          f.chat_id === childChat.id &&
          (f.tree as { parent: { title: string } | null }).parent?.title === "Parent after",
      );
      const header = await api<{ title: string }>(stack.memberToken, "GET", `/api/v1/chats/${rootChat}/tree`);
      expect(header.title).toBe("Parent after");
    } finally {
      ws.end();
    }
  });

  it("refuses stop and close on a chat the caller does not own", { timeout: TEST_TIMEOUT }, async () => {
    const agentId = await createAgent(stack.memberToken, `owned-${crypto.randomUUID().slice(0, 8)}`, "private");
    const thread = await api<{ thread: { chat_id: string } }>(
      stack.memberToken,
      "POST",
      `/api/v1/agents/${agentId}/threads`,
      {
        title: "Owner only",
      },
    );
    // An admin may read the member's chat but never act on it.
    const read = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/chats/${thread.thread.chat_id}/tree`,
      headers: auth(stack.adminToken),
    });
    expect(read.statusCode).toBe(200);
    for (const action of ["cancel", "close"]) {
      const res = await stack.env.app.inject({
        method: "POST",
        url: `/api/v1/threads/${thread.thread.chat_id}/${action}`,
        headers: { authorization: `Bearer ${stack.adminToken}` },
      });
      expect(res.statusCode).toBe(404);
    }
    const own = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/threads/${thread.thread.chat_id}/cancel`,
      headers: { authorization: `Bearer ${stack.memberToken}` },
    });
    expect(own.statusCode).toBe(200);
  });
});

describe("agent-state burst coalescing", () => {
  afterEach(() => vi.useRealTimers());

  /** A feed over one connected member whose catalog reads are counted;
   *  each read returns a new value so no push is deduped away. */
  function catalogFeed() {
    let reads = 0;
    const sent: unknown[] = [];
    const sink = {
      send: (frame: unknown) => {
        sent.push(frame);
        return true;
      },
    };
    const ctx = {
      hub: { memberUsersOfOrg: () => ["u"], memberSinksOfUser: () => [sink] },
      skills: {
        catalog: async () => [{ read: ++reads }],
        installsForUsers: async () => new Map(),
      },
    } as unknown as AgentStateDeps;
    const feed = new AgentStateFeed(ctx, (_channel, error) => {
      throw error;
    });
    const notify = () => feed.skills({ org_id: "org", agent_id: null, run_id: null, user_id: null });
    return { feed, notify, reads: () => reads, sent };
  }

  it("re-reads once for writes inside the quiet window", async () => {
    vi.useFakeTimers();
    const { feed, notify, reads, sent } = catalogFeed();
    notify();
    await vi.advanceTimersByTimeAsync(BURST_QUIET_MS - 30);
    notify();
    await vi.advanceTimersByTimeAsync(BURST_QUIET_MS - 30);
    notify();
    expect(reads()).toBe(0);
    await vi.advanceTimersByTimeAsync(BURST_QUIET_MS);
    expect(reads()).toBe(1);
    expect(sent).toHaveLength(1);
    // A write after the window is a new burst.
    notify();
    await vi.advanceTimersByTimeAsync(BURST_QUIET_MS);
    expect(reads()).toBe(2);
    feed.stop();
  });

  it("pushes a steady stream of writes no later than the cap after the first", async () => {
    vi.useFakeTimers();
    const { feed, notify, reads } = catalogFeed();
    notify();
    for (let elapsed = 0; elapsed < BURST_MAX_MS - 10; elapsed += 10) {
      await vi.advanceTimersByTimeAsync(10);
      notify();
    }
    expect(reads()).toBe(0);
    await vi.advanceTimersByTimeAsync(10);
    expect(reads()).toBe(1);
    feed.stop();
  });
});
