// Agent conversation tools: send_message opens a user-visible thread with an
// inbox notice; search/read stay scoped to the calling agent's own threads.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "../../platform/store/identity.js";
import { ChatStore } from "../../platform/store/chats.js";
import { ThreadStore } from "../../platform/store/thread.js";
import { AgentStore } from "../../agents/store.js";
import {
  createAgentTools,
  readAgentConversation,
  searchAgentConversations,
  sendAgentMessage,
} from "../../agents/tools.js";
import { createAgentsTestEnv } from "./harness.js";
import type { M5TestEnv } from "../platform/m5-harness.js";

const env: M5TestEnv | null = await createAgentsTestEnv();
const dbDescribe = env === null ? describe.skip : describe;

dbDescribe("agent conversation tools", () => {
  let store: AgentStore;
  let threads: ThreadStore;
  let chats: ChatStore;
  let owner: UserRow;
  let orgId: string;
  let agent: Awaited<ReturnType<AgentStore["create"]>>;
  let other: Awaited<ReturnType<AgentStore["create"]>>;

  beforeAll(async () => {
    if (env === null) return;
    store = new AgentStore(env.db);
    threads = new ThreadStore(env.db);
    chats = new ChatStore(env.db);
    orgId = randomUUID();
    await env.db.query("INSERT INTO orgs (id, name) VALUES ($1, 'agents-tools-org')", [orgId]);
    const id = randomUUID();
    const res = await env.db.query(
      `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
       VALUES ($1, $2, 'agents-tools@example.test', '', 'member', 'managed')
       RETURNING id, org_id, email, role, identity_type`,
      [id, orgId],
    );
    owner = {
      ...(res.rows[0] as Omit<UserRow, "display_name" | "avatar_url" | "onboarded_at">),
      display_name: null,
      avatar_url: null,
      onboarded_at: null,
    };
    agent = await store.create(owner, { name: "Sender", model: "GLM-Test" });
    other = await store.create(owner, { name: "Other", model: "GLM-Test" });
  }, 60_000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("send_message creates a thread, assistant message, unread chat and notice", async () => {
    const result = await sendAgentMessage(
      { pool: env!.db, store, threads, agent, userId: owner.id },
      { text: "The report is ready." },
    );
    const thread = await store.getThread(agent.id, owner.id, result.thread_id);
    expect(thread.title).toBe("The report is ready.");
    expect(result.url).toBe(`/thread/${thread.chat_id}`);
    const events = await threads.listEvents(orgId, thread.chat_id);
    expect(events.some((row) => row.event.type === "assistant_message")).toBe(true);
    const list = await chats.listChats(orgId, owner.id);
    expect(list.find((row) => row.id === thread.chat_id)?.unread).toBe(true);
    const notices = await store.listNotices(owner.id, orgId);
    expect(notices[0]).toMatchObject({
      kind: "agent_message",
      agent_id: agent.id,
      payload: { thread_id: thread.id, url: result.url },
    });
  });

  it("send_message records the calling thread as the delivered thread's origin", async () => {
    const run = await store.createThread(agent.id, owner.id, "Morning email digest — run", "routine_run");
    const result = await sendAgentMessage(
      { pool: env!.db, store, threads, agent, userId: owner.id, chatId: run.chat_id },
      { text: "The digest is ready.", title: "Morning digest" },
    );
    const delivered = await store.getThread(agent.id, owner.id, result.thread_id);
    expect(delivered.origin_thread_id).toBe(run.id);
    expect(delivered.kind).toBe("thread");
  });

  it("registers the routine management tools", () => {
    const tools = createAgentTools({ pool: env!.db, store, threads, agent, userId: owner.id });
    const names = tools.map((tool) => tool.name);
    expect(names).toContain("schedule_reminder");
    expect(names).toContain("list_routines");
    expect(names).toContain("create_routine");
    expect(names).toContain("update_routine");
    expect(names).toContain("delete_routine");
  });

  it("set_description rewrites only the caller's own description", async () => {
    const tools = createAgentTools({ pool: env!.db, store, threads, agent, userId: owner.id });
    const setDescription = tools.find((tool) => tool.name === "set_description");
    expect(setDescription).toBeDefined();
    const call = (args: Record<string, unknown>) =>
      setDescription!.execute(args as never, {} as never, {} as never) as Promise<{
        structuredOutput?: { description: string };
        isError?: boolean;
      }>;

    const written = await call({ description: "  Writes launch notes.  " });
    expect(written.structuredOutput).toEqual({ description: "Writes launch notes." });
    expect((await store.fetchAgent(agent.id)).description).toBe("Writes launch notes.");

    const cleared = await call({ description: "   " });
    expect(cleared.structuredOutput).toEqual({ description: "" });
    expect((await store.fetchAgent(agent.id)).description).toBe("");

    const atCap = "d".repeat(500);
    const boundary = await call({ description: atCap });
    expect(boundary.structuredOutput).toEqual({ description: atCap });

    const tooLong = await call({ description: "d".repeat(501) });
    expect(tooLong.isError).toBe(true);
    expect((await store.fetchAgent(agent.id)).description).toBe(atCap);

    // No agent argument exists; a stray one must not redirect the write.
    await call({ description: "Mine", agent_id: other.id });
    expect((await store.fetchAgent(agent.id)).description).toBe("Mine");
    expect((await store.fetchAgent(other.id)).description).toBe("");
  });

  it("search and read are scoped to the calling agent", async () => {
    const ownThread = (await store.listThreads(agent.id, owner.id))[0]!;
    const otherThread = (await store.listThreads(other.id, owner.id))[0]!;
    await store.insertChunks([
      {
        thread_id: ownThread.id,
        agent_id: agent.id,
        seq_from: 1,
        seq_to: 2,
        text: "User: find the lighthouse\n\nAssistant: it is on the coast.",
      },
      {
        thread_id: otherThread.id,
        agent_id: other.id,
        seq_from: 1,
        seq_to: 2,
        text: "User: lighthouse belongs to the other agent",
      },
    ]);
    const hits = await searchAgentConversations(store, agent.id, "lighthouse");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.thread_id).toBe(ownThread.id);

    const own = await readAgentConversation(env!.db, agent.id, { threadId: ownThread.id });
    expect(own?.thread_title).toBe(ownThread.title);
    expect(await readAgentConversation(env!.db, agent.id, { threadId: otherThread.id })).toBeNull();
  });
});
