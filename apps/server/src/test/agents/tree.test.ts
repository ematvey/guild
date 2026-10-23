// GET /api/v1/chats/:id/tree: the chat header's node facts — kind, title,
// depth, latest run status and the parent chat of a delegated child.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupM2Stack, type M2Stack } from "../platform/m2-harness.js";

let stack: M2Stack;

const auth = (): Record<string, string> => ({
  authorization: `Bearer ${stack.memberToken}`,
  "content-type": "application/json",
});

async function insertChat(title: string): Promise<string> {
  const id = randomUUID();
  await stack.env.db.query("INSERT INTO chats (id, org_id, user_id, title) VALUES ($1, $2, $3, $4)", [
    id,
    stack.orgId,
    stack.memberId,
    title,
  ]);
  return id;
}

beforeAll(async () => {
  stack = await setupM2Stack();
}, 60_000);

afterAll(async () => {
  await stack.close();
}, 30_000);

describe("chat tree", () => {
  it("resolves a delegated child's parent chat and title", async () => {
    const agentId = randomUUID();
    await stack.env.db.query(
      `INSERT INTO agents (id, org_id, owner_user_id, name, model)
       VALUES ($1, $2, $3, 'Tree agent', 'GLM-Test-Model')`,
      [agentId, stack.orgId, stack.memberId],
    );
    const parentChat = await insertChat("Parent chat");
    const parentThread = randomUUID();
    await stack.env.db.query(
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, kind)
       VALUES ($1, $2, $3, $4, 'Parent session', 'thread')`,
      [parentThread, agentId, stack.memberId, parentChat],
    );
    const childChat = await insertChat("Child chat");
    const childThread = randomUUID();
    await stack.env.db.query(
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, kind, parent_thread_id, depth)
       VALUES ($1, $2, $3, $4, 'Child session', 'delegated', $5, 1)`,
      [childThread, agentId, stack.memberId, childChat, parentThread],
    );
    await stack.env.db.query(
      `INSERT INTO agent_runs (id, agent_id, user_id, thread_id, trigger, status, started_at, finished_at)
       VALUES ($1, $2, $3, $4, 'delegation', 'succeeded', now(), now())`,
      [randomUUID(), agentId, stack.memberId, childThread],
    );

    const res = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/chats/${childChat}/tree`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      chat_id: childChat,
      kind: "delegated",
      title: "Child session",
      agent_id: agentId,
      agent_name: "Tree agent",
      status: "succeeded",
      depth: 1,
      parent: { chat_id: parentChat, title: "Parent session" },
    });

    const alias = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/threads/${childChat}/tree`,
      headers: auth(),
    });
    expect(alias.statusCode).toBe(200);
    expect(JSON.parse(alias.body)).toEqual(JSON.parse(res.body));
  });

  it("returns a plain chat with parent null and its thread kind", async () => {
    const plainChat = await insertChat("Plain chat");
    const plain = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/chats/${plainChat}/tree`,
      headers: auth(),
    });
    expect(plain.statusCode).toBe(200);
    expect(JSON.parse(plain.body)).toEqual({
      chat_id: plainChat,
      kind: "chat",
      title: "Plain chat",
      agent_id: null,
      agent_name: null,
      status: null,
      depth: 0,
      parent: null,
    });

    const agentId = randomUUID();
    await stack.env.db.query(
      `INSERT INTO agents (id, org_id, owner_user_id, name, model)
       VALUES ($1, $2, $3, 'Plain agent', 'GLM-Test-Model')`,
      [agentId, stack.orgId, stack.memberId],
    );
    const threadChat = await insertChat("Thread chat");
    await stack.env.db.query(
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, kind)
       VALUES ($1, $2, $3, $4, 'Thread session', 'thread')`,
      [randomUUID(), agentId, stack.memberId, threadChat],
    );
    const threaded = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/chats/${threadChat}/tree`,
      headers: auth(),
    });
    expect(threaded.statusCode).toBe(200);
    expect(JSON.parse(threaded.body)).toEqual({
      chat_id: threadChat,
      kind: "thread",
      title: "Thread session",
      agent_id: agentId,
      agent_name: "Plain agent",
      status: null,
      depth: 0,
      parent: null,
    });
  });
});
