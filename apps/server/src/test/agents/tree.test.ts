// GET /api/v1/chats/:id/tree: the chat header's node facts — type, title,
// depth, latest run status and the parent chat of a delegated child. A
// thread is named by its chat's title (what the sidebar shows); the thread
// row's own title stands in only while the chat has none.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { waitFor } from "../support/wait.js";
import { setupGatewayStack, type GatewayStack } from "../support/gateway-stack.js";

let stack: GatewayStack;

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
  stack = await setupGatewayStack();
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
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, type)
       VALUES ($1, $2, $3, $4, 'Parent session', 'user')`,
      [parentThread, agentId, stack.memberId, parentChat],
    );
    const childChat = await insertChat("Child chat");
    const childThread = randomUUID();
    await stack.env.db.query(
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, type, parent_thread_id, depth)
       VALUES ($1, $2, $3, $4, 'Child session', 'subagent', $5, 1)`,
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
      type: "subagent",
      title: "Child chat",
      agent_id: agentId,
      agent_name: "Tree agent",
      status: "succeeded",
      depth: 1,
      parent: { chat_id: parentChat, title: "Parent chat" },
      origin: null,
      archived: false,
      deleted: false,
      own: true,
    });

    const alias = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/threads/${childChat}/tree`,
      headers: auth(),
    });
    expect(alias.statusCode).toBe(200);
    expect(JSON.parse(alias.body)).toEqual(JSON.parse(res.body));
  });

  it("lists the whole subtree with each node's latest run status", async () => {
    const agentId = randomUUID();
    await stack.env.db.query(
      `INSERT INTO agents (id, org_id, owner_user_id, name, model)
       VALUES ($1, $2, $3, 'Tree agent', 'GLM-Test-Model')`,
      [agentId, stack.orgId, stack.memberId],
    );
    const rootChat = await insertChat("Root chat");
    const rootThread = randomUUID();
    await stack.env.db.query(
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, type)
       VALUES ($1, $2, $3, $4, 'Root session', 'user')`,
      [rootThread, agentId, stack.memberId, rootChat],
    );
    const childChat = await insertChat("Child chat");
    const childThread = randomUUID();
    await stack.env.db.query(
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, type, parent_thread_id, depth)
       VALUES ($1, $2, $3, $4, 'Child session', 'subagent', $5, 1)`,
      [childThread, agentId, stack.memberId, childChat, rootThread],
    );
    const grandchildChat = await insertChat("Grandchild chat");
    const grandchildThread = randomUUID();
    await stack.env.db.query(
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, type, parent_thread_id, depth)
       VALUES ($1, $2, $3, $4, 'Grandchild session', 'subagent', $5, 2)`,
      [grandchildThread, agentId, stack.memberId, grandchildChat, childThread],
    );
    await stack.env.db.query(
      `INSERT INTO agent_runs (id, agent_id, user_id, thread_id, trigger, status, started_at)
       VALUES ($1, $2, $3, $4, 'delegation', 'running', now())`,
      [randomUUID(), agentId, stack.memberId, childThread],
    );

    const res = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/chats/${rootChat}/subagents`,
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      chat_id: string;
      nodes: {
        thread_id: string;
        parent_thread_id: string | null;
        status: string | null;
        title: string;
        depth: number;
      }[];
    };
    expect(body.chat_id).toBe(rootChat);
    expect(body.nodes.map((n) => [n.thread_id, n.parent_thread_id, n.status])).toEqual([
      [rootThread, null, null],
      [childThread, rootThread, "running"],
      [grandchildThread, childThread, null],
    ]);
    expect(body.nodes.map((n) => n.depth)).toEqual([0, 1, 2]);
    expect(body.nodes.map((n) => n.title)).toEqual(["Root chat", "Child chat", "Grandchild chat"]);

    // A plain chat has no thread row: an empty subtree, not an error.
    const plainChat = await insertChat("Plain chat");
    const plain = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/chats/${plainChat}/subagents`,
      headers: auth(),
    });
    expect(plain.statusCode).toBe(200);
    expect(JSON.parse(plain.body).nodes).toEqual([]);
  });

  it("returns a plain chat with parent null and its thread type", async () => {
    const plainChat = await insertChat("Plain chat");
    const plain = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/chats/${plainChat}/tree`,
      headers: auth(),
    });
    expect(plain.statusCode).toBe(200);
    expect(JSON.parse(plain.body)).toEqual({
      chat_id: plainChat,
      type: "user",
      title: "Plain chat",
      agent_id: null,
      agent_name: null,
      status: null,
      depth: 0,
      parent: null,
      origin: null,
      archived: false,
      deleted: false,
      own: true,
    });

    const agentId = randomUUID();
    await stack.env.db.query(
      `INSERT INTO agents (id, org_id, owner_user_id, name, model)
       VALUES ($1, $2, $3, 'Plain agent', 'GLM-Test-Model')`,
      [agentId, stack.orgId, stack.memberId],
    );
    const threadChat = await insertChat("Thread chat");
    await stack.env.db.query(
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, type)
       VALUES ($1, $2, $3, $4, 'Thread session', 'user')`,
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
      type: "user",
      title: "Thread chat",
      agent_id: agentId,
      agent_name: "Plain agent",
      status: null,
      depth: 0,
      parent: null,
      origin: null,
      archived: false,
      deleted: false,
      own: true,
    });
  });
});

describe("thread stop actions", () => {
  async function delegatedChild(): Promise<{ chatId: string; threadId: string; runId: string }> {
    const agentId = randomUUID();
    await stack.env.db.query(
      `INSERT INTO agents (id, org_id, owner_user_id, name, model)
       VALUES ($1, $2, $3, 'Stop agent', 'GLM-Test-Model')`,
      [agentId, stack.orgId, stack.memberId],
    );
    const parentChat = await insertChat("Stop parent");
    const parentThread = randomUUID();
    await stack.env.db.query(
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, type)
       VALUES ($1, $2, $3, $4, 'Stop parent session', 'user')`,
      [parentThread, agentId, stack.memberId, parentChat],
    );
    const childChat = await insertChat("Stop child");
    const childThread = randomUUID();
    await stack.env.db.query(
      `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, type, parent_thread_id, depth)
       VALUES ($1, $2, $3, $4, 'Stop child session', 'subagent', $5, 1)`,
      [childThread, agentId, stack.memberId, childChat, parentThread],
    );
    const runId = randomUUID();
    await stack.env.db.query(
      `INSERT INTO agent_runs (id, agent_id, user_id, thread_id, status, trigger)
       VALUES ($1, $2, $3, $4, 'running', 'delegation')`,
      [runId, agentId, stack.memberId, childThread],
    );
    return { chatId: childChat, threadId: childThread, runId };
  }

  it("close marks the child thread closed and cancels its run", async () => {
    const child = await delegatedChild();
    const res = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/threads/${child.chatId}/close`,
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ thread_id: child.threadId, closed: 1, cancelled: 1 });
    const thread = await stack.env.db.query<{ closed_at: Date | null }>(
      "SELECT closed_at FROM agent_threads WHERE id = $1",
      [child.threadId],
    );
    expect(thread.rows[0]?.closed_at).not.toBeNull();
    const run = await stack.env.db.query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [
      child.runId,
    ]);
    expect(run.rows[0]?.status).toBe("cancelled");
  });

  it("close writes child_closed to the parent chat once", async () => {
    const child = await delegatedChild();
    const parentChat = await stack.env.db.query<{ chat_id: string }>(
      "SELECT chat_id FROM agent_threads WHERE id = (SELECT parent_thread_id FROM agent_threads WHERE id = $1)",
      [child.threadId],
    );
    const parentChatId = parentChat.rows[0]!.chat_id;

    const first = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/threads/${child.chatId}/close`,
      headers: auth(),
      payload: {},
    });
    expect(first.statusCode, first.body).toBe(200);
    // The close is a notice in the parent's conversation; the row is
    // projected from it.
    const closedRows = () =>
      stack.env.db.query<{ payload: { thread_id: string } }>(
        "SELECT payload FROM thread_events WHERE chat_id = $1 AND type = 'child_closed' ORDER BY seq",
        [parentChatId],
      );
    await waitFor(async () => (await closedRows()).rows.length === 1, 10_000, 50, "no child_closed row");
    const closedEvents = await closedRows();
    expect(closedEvents.rows).toHaveLength(1);
    expect(closedEvents.rows[0]!.payload.thread_id).toBe(child.threadId);

    const second = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/threads/${child.chatId}/close`,
      headers: auth(),
      payload: {},
    });
    expect(second.statusCode, second.body).toBe(200);
    expect(JSON.parse(second.body).closed).toBe(0);
    const afterSecond = await stack.env.db.query(
      "SELECT 1 FROM thread_events WHERE chat_id = $1 AND type = 'child_closed'",
      [parentChatId],
    );
    expect(afterSecond.rows).toHaveLength(1);
  });

  it("cancel stops the run and leaves the thread open", async () => {
    const child = await delegatedChild();
    const parentChat = await stack.env.db.query<{ chat_id: string }>(
      "SELECT chat_id FROM agent_threads WHERE id = (SELECT parent_thread_id FROM agent_threads WHERE id = $1)",
      [child.threadId],
    );
    const res = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/threads/${child.chatId}/cancel`,
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ thread_id: child.threadId, cancelled: 1 });
    const thread = await stack.env.db.query<{ closed_at: Date | null }>(
      "SELECT closed_at FROM agent_threads WHERE id = $1",
      [child.threadId],
    );
    expect(thread.rows[0]?.closed_at).toBeNull();
    const closedEvents = await stack.env.db.query(
      "SELECT 1 FROM thread_events WHERE chat_id = $1 AND type = 'child_closed'",
      [parentChat.rows[0]!.chat_id],
    );
    expect(closedEvents.rows).toHaveLength(0);
  });

  it("refuses to close a root thread", async () => {
    const child = await delegatedChild();
    const parentChat = await stack.env.db.query<{ chat_id: string }>(
      "SELECT chat_id FROM agent_threads WHERE id = (SELECT parent_thread_id FROM agent_threads WHERE id = $1)",
      [child.threadId],
    );
    const res = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/threads/${parentChat.rows[0]!.chat_id}/close`,
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(400);
  });

  it("404s for a chat with no thread row", async () => {
    const chatId = await insertChat("No thread");
    const res = await stack.env.app.inject({
      method: "POST",
      url: `/api/v1/threads/${chatId}/close`,
      headers: auth(),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(404);
  });
});

describe("thread delete", () => {
  /** A user thread with a child and a grandchild; the grandchild runs. */
  async function threeLevels(): Promise<{ chats: string[]; threads: string[]; runId: string }> {
    const agentId = randomUUID();
    await stack.env.db.query(
      `INSERT INTO agents (id, org_id, owner_user_id, name, model)
       VALUES ($1, $2, $3, 'Delete agent', 'GLM-Test-Model')`,
      [agentId, stack.orgId, stack.memberId],
    );
    const chats: string[] = [];
    const threads: string[] = [];
    for (const [depth, label] of ["Root", "Scout", "Scout's helper"].entries()) {
      const chatId = await insertChat(label);
      const threadId = randomUUID();
      await stack.env.db.query(
        `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, type, parent_thread_id, depth)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          threadId,
          agentId,
          stack.memberId,
          chatId,
          label,
          depth === 0 ? "user" : "subagent",
          threads.at(-1) ?? null,
          depth,
        ],
      );
      chats.push(chatId);
      threads.push(threadId);
    }
    const runId = randomUUID();
    await stack.env.db.query(
      `INSERT INTO agent_runs (id, agent_id, user_id, thread_id, status, trigger)
       VALUES ($1, $2, $3, $4, 'running', 'delegation')`,
      [runId, agentId, stack.memberId, threads[2]],
    );
    return { chats, threads, runId };
  }

  const flags = async (chatIds: string[]): Promise<Record<string, { deleted: boolean; closed: boolean }>> => {
    const res = await stack.env.db.query<{ id: string; deleted: boolean; closed: boolean }>(
      `SELECT c.id, c.deleted_at IS NOT NULL AS deleted, t.closed_at IS NOT NULL AS closed
       FROM chats c JOIN agent_threads t ON t.chat_id = c.id WHERE c.id = ANY($1::uuid[])`,
      [chatIds],
    );
    return Object.fromEntries(res.rows.map((r) => [r.id, { deleted: r.deleted, closed: r.closed }]));
  };

  it("deleting a chat deletes and closes its whole agent-thread subtree", async () => {
    const tree = await threeLevels();
    const res = await stack.env.app.inject({
      method: "DELETE",
      url: `/api/v1/threads/${tree.chats[0]}`,
      headers: { authorization: `Bearer ${stack.memberToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = await flags(tree.chats);
    for (const chatId of tree.chats) expect(after[chatId]).toEqual({ deleted: true, closed: true });
    const run = await stack.env.db.query<{ status: string }>("SELECT status FROM agent_runs WHERE id = $1", [
      tree.runId,
    ]);
    expect(run.rows[0]!.status).toBe("cancelled");

    // The child's header reports the deletion, and the child refuses writes.
    const header = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/chats/${tree.chats[1]}/tree`,
      headers: auth(),
    });
    expect(JSON.parse(header.body)).toMatchObject({ type: "subagent", deleted: true });
    const rename = await stack.env.app.inject({
      method: "PATCH",
      url: `/api/v1/threads/${tree.chats[1]}`,
      headers: auth(),
      payload: { title: "revived" },
    });
    expect(rename.statusCode).toBe(404);
  });

  it("the owner deletes a child directly: its subtree goes, its parent stays", async () => {
    const tree = await threeLevels();
    const res = await stack.env.app.inject({
      method: "DELETE",
      url: `/api/v1/threads/${tree.chats[1]}`,
      headers: { authorization: `Bearer ${stack.memberToken}` },
    });
    expect(res.statusCode, res.body).toBe(200);
    const after = await flags(tree.chats);
    expect(after[tree.chats[0]!]).toEqual({ deleted: false, closed: false });
    expect(after[tree.chats[1]!]).toEqual({ deleted: true, closed: true });
    expect(after[tree.chats[2]!]).toEqual({ deleted: true, closed: true });
  });

  it("another user cannot delete a child chat", async () => {
    const tree = await threeLevels();
    const res = await stack.env.app.inject({
      method: "DELETE",
      url: `/api/v1/threads/${tree.chats[1]}`,
      headers: { authorization: `Bearer ${stack.adminToken}` },
    });
    expect(res.statusCode).toBe(404);
    const after = await flags(tree.chats);
    for (const chatId of tree.chats) expect(after[chatId]!.deleted).toBe(false);
  });
});
