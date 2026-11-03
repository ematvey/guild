// Conversation history: the Activity surface's base layer. A conversation
// list is org-scoped (admin) or owner-scoped (member); a conversation detail
// groups a page of messages around the runs that answered them; a run detail
// names its thread and the parent thread it came from.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupGatewayStack, type GatewayStack } from "./support/gateway-stack.js";
import { groupConversation } from "../platform/store/conversation-history.js";

let stack: GatewayStack;
const auth = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

interface Seed {
  chatId: string;
  threadId: string;
  runIds: string[];
}

/** One agent, one chat, one thread, two runs and their messages. */
async function seedConversation(opts: {
  userId: string;
  agentName: string;
  title: string;
  parentThreadId?: string;
}): Promise<Seed> {
  const db = stack.env.db;
  const agentId = randomUUID();
  await db.query("INSERT INTO agents (id, org_id, owner_user_id, name, model) VALUES ($1,$2,$3,$4,$5)", [
    agentId,
    stack.orgId,
    opts.userId,
    opts.agentName,
    "trace-model",
  ]);
  const chatId = randomUUID();
  await db.query("INSERT INTO chats (id, org_id, user_id, title) VALUES ($1,$2,$3,$4)", [
    chatId,
    stack.orgId,
    opts.userId,
    opts.title,
  ]);
  const threadId = randomUUID();
  await db.query(
    "INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, type, parent_thread_id) VALUES ($1,$2,$3,$4,$5,'user',$6)",
    [threadId, agentId, opts.userId, chatId, opts.title, opts.parentThreadId ?? null],
  );
  const runIds = [randomUUID(), randomUUID()];
  const base = Date.parse("2026-11-01T10:00:00Z");
  const times = [0, 60_000];
  for (let i = 0; i < runIds.length; i++) {
    const start = new Date(base + times[i]!).toISOString();
    const end = new Date(base + times[i]! + 30_000).toISOString();
    await db.query(
      `INSERT INTO agent_runs (id, agent_id, user_id, thread_id, trigger, status, summary, started_at, finished_at)
       VALUES ($1,$2,$3,$4,'message','succeeded',$5,$6,$7)`,
      [runIds[i], agentId, opts.userId, threadId, `answer ${i + 1}`, start, end],
    );
    await db.query(
      "INSERT INTO thread_events (id, chat_id, type, payload, created_at) VALUES ($1,$2,'user_message',$3,$4)",
      [
        randomUUID(),
        chatId,
        JSON.stringify({ type: "user_message", content: `question ${i + 1}`, attachments: [] }),
        new Date(base + times[i]! - 1_000).toISOString(),
      ],
    );
    await db.query(
      "INSERT INTO thread_events (id, chat_id, type, payload, created_at) VALUES ($1,$2,'assistant_message',$3,$4)",
      [
        randomUUID(),
        chatId,
        JSON.stringify({
          type: "assistant_message",
          turn: i + 1,
          step: 1,
          blocks: [{ type: "text", text: `reply ${i + 1}` }],
          usage: { tokens_in: 1, tokens_out: 1 },
          model: "trace-model",
        }),
        end,
      ],
    );
  }
  return { chatId, threadId, runIds };
}

beforeAll(async () => {
  stack = await setupGatewayStack({}, { dbPrefix: "guild_conversations_test_" });
}, 60_000);

afterAll(async () => {
  await stack.close();
}, 30_000);

describe("groupConversation", () => {
  it("puts the trigger before its run and the reply after it", () => {
    const messages = [
      { seq: 1, role: "user" as const, text: "hello", ts: "2026-11-01T10:00:00Z" },
      { seq: 2, role: "assistant" as const, text: "hi", ts: "2026-11-01T10:00:30Z" },
      { seq: 3, role: "user" as const, text: "again", ts: "2026-11-01T10:01:00Z" },
    ];
    const runs = [
      {
        id: "r1",
        agent_id: "a",
        agent_name: "Echo",
        trigger: "message",
        status: "succeeded",
        summary: "",
        error_message: "",
        tokens: 0,
        started_at: "2026-11-01T10:00:00Z",
        finished_at: "2026-11-01T10:00:30Z",
      },
    ];
    const items = groupConversation(messages, runs, () => ({ call_count: 2, tool_count: 3 }));
    expect(items.map((item) => (item.kind === "run" ? "run" : item.role))).toEqual(["run", "assistant", "user"]);
    const run = items[0];
    if (run?.kind !== "run") throw new Error("first item is not a run");
    expect(run.trigger).toBe("hello");
    expect(run.steps).toBe(5);
    expect(run.reply).toBe(true);
  });

  it("keeps an earlier user message standalone when two precede one run", () => {
    const messages = [
      { seq: 1, role: "user" as const, text: "first", ts: "2026-11-01T09:59:00Z" },
      { seq: 2, role: "user" as const, text: "second", ts: "2026-11-01T09:59:30Z" },
    ];
    const runs = [
      {
        id: "r1",
        agent_id: "a",
        agent_name: "Echo",
        trigger: "message",
        status: "running",
        summary: "",
        error_message: "",
        tokens: 0,
        started_at: "2026-11-01T10:00:00Z",
        finished_at: null,
      },
    ];
    const items = groupConversation(messages, runs, () => ({ call_count: 0, tool_count: 0 }));
    expect(items.map((item) => (item.kind === "run" ? "run" : item.text))).toEqual(["first", "run"]);
    expect(items[1]?.kind === "run" && items[1].trigger).toBe("second");
  });
});

describe("conversation activity", () => {
  let mine: Seed;
  let other: Seed;

  beforeAll(async () => {
    mine = await seedConversation({ userId: stack.memberId, agentName: "Echo", title: "Member history" });
    other = await seedConversation({ userId: stack.adminId, agentName: "Admin Bot", title: "Admin history" });
  });

  it("lists the org for an admin and only the member's own rows for a member", async () => {
    const admin = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/activity/conversations",
      headers: auth(stack.adminToken),
    });
    expect(admin.statusCode).toBe(200);
    const adminBody = JSON.parse(admin.body) as {
      conversations: { id: string; title: string; owner: { id: string }; runs: number; messages: number }[];
      total: number;
    };
    const ids = adminBody.conversations.map((row) => row.id);
    expect(ids).toContain(mine.chatId);
    expect(ids).toContain(other.chatId);
    const row = adminBody.conversations.find((item) => item.id === mine.chatId)!;
    expect(row.title).toBe("Member history");
    expect(row.owner.id).toBe(stack.memberId);
    expect(row.runs).toBe(2);
    expect(row.messages).toBe(4);

    const member = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/activity/conversations",
      headers: auth(stack.memberToken),
    });
    const memberBody = JSON.parse(member.body) as { conversations: { id: string }[] };
    expect(memberBody.conversations.map((item) => item.id)).toEqual([mine.chatId]);
  });

  it("searches by owner and title", async () => {
    const res = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/activity/conversations?q=Admin%20history",
      headers: auth(stack.adminToken),
    });
    const body = JSON.parse(res.body) as { conversations: { id: string }[] };
    expect(body.conversations.map((item) => item.id)).toEqual([other.chatId]);
  });

  it("groups one conversation into trigger, run and reply", async () => {
    const res = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/activity/conversations/${mine.chatId}`,
      headers: auth(stack.adminToken),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      conversation: { id: string; owner: { id: string }; agent: { name: string } };
      items: ({ kind: string } & Record<string, unknown>)[];
      has_more: boolean;
    };
    expect(body.conversation.owner.id).toBe(stack.memberId);
    expect(body.conversation.agent.name).toBe("Echo");
    expect(body.has_more).toBe(false);
    const shape = body.items.map((item) => (item.kind === "run" ? "run" : String(item.role)));
    expect(shape).toEqual(["run", "assistant", "run", "assistant"]);
    const first = body.items[0]!;
    expect(first.trigger).toBe("question 1");
    expect(first.run).toMatchObject({ status: "succeeded", trigger: "message" });
    expect(body.items[1]!.text).toBe("reply 1");
  });

  it("hides another member's conversation from a member", async () => {
    const res = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/activity/conversations/${other.chatId}`,
      headers: auth(stack.memberToken),
    });
    expect(res.statusCode).toBe(404);
  });

  it("names the thread and the parent thread on a run", async () => {
    const child = await seedConversation({
      userId: stack.memberId,
      agentName: "Echo",
      title: "Child thread",
      parentThreadId: mine.threadId,
    });
    const res = await stack.env.app.inject({
      method: "GET",
      url: `/api/v1/runs/${child.runIds[0]}`,
      headers: auth(stack.memberToken),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      thread: { id: string; parent_chat_id: string | null; parent_title: string | null };
      run: { steps: { kind: string; detail: string | null }[] };
    };
    expect(body.thread.id).toBe(child.threadId);
    expect(body.thread.parent_chat_id).toBe(mine.chatId);
    expect(body.thread.parent_title).toBe("Member history");

    // The run opens with the user message that started it, even though the
    // message predates the run's start.
    const steps = body.run.steps as { kind: string; detail: string | null }[];
    expect(steps[0]).toMatchObject({ kind: "user", detail: "question 1" });
  });
});
