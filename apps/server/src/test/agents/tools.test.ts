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
import { insertChunks } from "../../agents/search.js";
import { createRoutine } from "../../agents/routines.js";
import { createAgentsTestEnv } from "./harness.js";
import type { HubTestEnv } from "../support/hub-env.js";

const env: HubTestEnv | null = await createAgentsTestEnv();
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
    store = new AgentStore({ pool: env.db, chats: new ChatStore(env.db) });
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
      { store, threads, agent, userId: owner.id },
      { text: "The report is ready." },
    );
    const thread = await store.threads.getThread(agent.id, owner.id, result.thread_id);
    expect(thread.title).toBe("The report is ready.");
    expect(result.url).toBe(`/thread/${thread.chat_id}`);
    const events = await threads.listEvents(orgId, thread.chat_id);
    expect(events.some((row) => row.event.type === "assistant_message")).toBe(true);
    const list = await chats.listChats(orgId, owner.id);
    expect(list.find((row) => row.id === thread.chat_id)?.unread).toBe(true);
    const notices = await store.notices.listNotices(owner.id, orgId);
    expect(notices[0]).toMatchObject({
      kind: "agent_message",
      agent_id: agent.id,
      payload: { thread_id: thread.id, url: result.url },
    });
  });

  it("send_message records the calling thread as the delivered thread's origin", async () => {
    const run = await store.threads.createThread(agent.id, owner.id, "Morning email digest — run", "routine");
    const result = await sendAgentMessage(
      { store, threads, agent, userId: owner.id, chatId: run.chat_id },
      { text: "The digest is ready.", title: "Morning digest" },
    );
    const delivered = await store.threads.getThread(agent.id, owner.id, result.thread_id);
    expect(delivered.origin_thread_id).toBe(run.id);
    expect(delivered.type).toBe("user");
  });

  it("send_message dedupes per user: two users of one agent get their own threads", async () => {
    const secondId = randomUUID();
    await env!.db.query(
      `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
       VALUES ($1, $2, 'agents-tools-second@example.test', '', 'member', 'managed')`,
      [secondId, orgId],
    );
    const args = { text: "Shared status update.", title: "Status update" };
    const first = await sendAgentMessage({ store, threads, agent, userId: owner.id }, args);
    const second = await sendAgentMessage({ store, threads, agent, userId: secondId }, args);
    expect(second.thread_id).not.toBe(first.thread_id);
    expect((await store.threads.getThread(agent.id, secondId, second.thread_id)).title).toBe("Status update");
    const repeat = await sendAgentMessage({ store, threads, agent, userId: owner.id }, args);
    expect(repeat.thread_id).toBe(first.thread_id);
  });

  async function routineRun(routineId: string, label: string): Promise<{ id: string; chat_id: string }> {
    const run = await store.threads.createThread(agent.id, owner.id, label, "routine");
    await store.runs.createRun({
      agent_id: agent.id,
      user_id: owner.id,
      thread_id: run.id,
      routine_id: routineId,
      trigger: "routine",
      status: "running",
    });
    return run;
  }

  it("send_message from a thread-delivery routine appends every run to one marked chat", async () => {
    const routine = await createRoutine(env!.db, agent.id, {
      created_by_user_id: owner.id,
      name: "Jira digest",
      kind: "cron",
      schedule: "every 1 hours",
      prompt: "Check Jira.",
    });
    expect(routine.delivery).toBe("thread");
    const first = await routineRun(routine.id, "Jira digest — 1");
    const second = await routineRun(routine.id, "Jira digest — 2");
    const a = await sendAgentMessage(
      { store, threads, agent, userId: owner.id, chatId: first.chat_id },
      { text: "Two new tasks.", title: "Jira update" },
    );
    const b = await sendAgentMessage(
      { store, threads, agent, userId: owner.id, chatId: second.chat_id },
      { text: "One more task.", title: "Jira update" },
    );
    expect(b.thread_id).toBe(a.thread_id);
    const feed = await store.threads.getThread(agent.id, owner.id, a.thread_id);
    expect(feed.title).toBe("Jira digest");
    expect(feed.title_locked).toBe(true);
    expect(feed.origin_thread_id).toBe(second.id);
    const events = await threads.listEvents(orgId, feed.chat_id);
    expect(events.filter((row) => row.event.type === "assistant_message")).toHaveLength(2);
    const row = (await chats.listChats(orgId, owner.id)).find((chat) => chat.id === feed.chat_id);
    expect(row?.routine).toEqual({ id: routine.id, name: "Jira digest" });
    expect(row?.unread).toBe(true);
    const context = await env!.db.query<{ routine_feed: boolean }>(
      "SELECT routine_feed FROM agent_threads WHERE id = $1",
      [feed.id],
    );
    expect(context.rows[0]?.routine_feed).toBe(true);

    // An archived feed is retired: the next delivery opens a new one.
    await env!.db.query("UPDATE chats SET archived_at = now() WHERE id = $1", [feed.chat_id]);
    const third = await routineRun(routine.id, "Jira digest — 3");
    const c = await sendAgentMessage(
      { store, threads, agent, userId: owner.id, chatId: third.chat_id },
      { text: "Quiet day." },
    );
    expect(c.thread_id).not.toBe(a.thread_id);
    const old = await env!.db.query<{ routine_feed: boolean; routine_id: string }>(
      "SELECT routine_feed, routine_id FROM agent_threads WHERE id = $1",
      [feed.id],
    );
    expect(old.rows[0]).toEqual({ routine_feed: false, routine_id: routine.id });
  });

  it("send_message from a new_chat routine opens a marked chat per message", async () => {
    const routine = await createRoutine(env!.db, agent.id, {
      created_by_user_id: owner.id,
      name: "Alerts",
      kind: "cron",
      schedule: "every 1 hours",
      prompt: "Check alerts.",
      delivery: "new_chat",
    });
    const first = await routineRun(routine.id, "Alerts — 1");
    const second = await routineRun(routine.id, "Alerts — 2");
    const a = await sendAgentMessage(
      { store, threads, agent, userId: owner.id, chatId: first.chat_id },
      { text: "Disk is full.", title: "Disk alert" },
    );
    const b = await sendAgentMessage(
      { store, threads, agent, userId: owner.id, chatId: second.chat_id },
      { text: "CPU is hot.", title: "CPU alert" },
    );
    expect(b.thread_id).not.toBe(a.thread_id);
    const list = await chats.listChats(orgId, owner.id);
    for (const result of [a, b]) {
      const chatId = result.url.replace("/thread/", "");
      expect(list.find((row) => row.id === chatId)?.routine).toEqual({ id: routine.id, name: "Alerts" });
    }
  });

  it("a plain send_message chat carries no routine mark", async () => {
    const result = await sendAgentMessage({ store, threads, agent, userId: owner.id }, { text: "Hello there." });
    const chatId = result.url.replace("/thread/", "");
    const row = (await chats.listChats(orgId, owner.id)).find((chat) => chat.id === chatId);
    expect(row?.routine).toBeNull();
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

  it("conversations_list filters by type and flags and pages with a cursor", async () => {
    const tools = createAgentTools({ pool: env!.db, store, threads, agent, userId: owner.id });
    const list = tools.find((tool) => tool.name === "conversations_list");
    expect(list).toBeDefined();
    const call = (args: Record<string, unknown>) =>
      list!.execute(args as never, {} as never, {} as never) as Promise<{
        structuredOutput?: {
          threads: { thread_id: string; type: string; archived: boolean; deleted: boolean }[];
          next_cursor: string | null;
        };
        isError?: boolean;
      }>;

    const main = (await store.threads.listThreads(agent.id, owner.id)).threads[0]!;
    const extra = await store.threads.createThread(agent.id, owner.id, "A user thread");
    const child = await store.threads.createChildThread(main.id, agent.id, owner.id, "A child");
    const routine = await store.threads.createThread(agent.id, owner.id, "A run", "routine");
    await chats.updateChat(orgId, extra.chat_id, owner, undefined, true);
    await chats.deleteChat(orgId, routine.chat_id, owner);

    // Default: live user threads only, newest activity first.
    const userPage = await call({ limit: 2 });
    expect(userPage.structuredOutput!.threads).toHaveLength(2);
    expect(userPage.structuredOutput!.threads.every((t) => t.type === "user")).toBe(true);
    expect(userPage.structuredOutput!.threads.every((t) => !t.archived && !t.deleted)).toBe(true);
    const second = await call({ limit: 2, cursor: userPage.structuredOutput!.next_cursor });
    expect(second.isError).toBeUndefined();
    expect(second.structuredOutput!.threads[0]!.thread_id).not.toBe(userPage.structuredOutput!.threads[0]!.thread_id);

    // The type filter is separate from the flags.
    const children = await call({ type: "subagent" });
    expect(children.structuredOutput!.threads.map((t) => t.thread_id)).toContain(child.id);

    // Archived and deleted are independent states, not types.
    const archived = await call({ archived: true });
    expect(archived.structuredOutput!.threads.map((t) => t.thread_id)).toContain(extra.id);
    const deleted = await call({ type: "routine", deleted: true });
    expect(deleted.structuredOutput!.threads.map((t) => t.thread_id)).toEqual([routine.id]);
    expect(deleted.structuredOutput!.threads[0]!.deleted).toBe(true);

    // A malformed cursor is an error, not a silent first page.
    expect((await call({ cursor: "not-a-cursor" })).isError).toBe(true);
  });

  it("search and read are scoped to the calling agent", async () => {
    const ownThread = (await store.threads.listThreads(agent.id, owner.id)).threads[0]!;
    const otherThread = (await store.threads.listThreads(other.id, owner.id)).threads[0]!;
    await insertChunks(env!.db, [
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
    const hits = await searchAgentConversations(env!.db, agent.id, owner.id, "lighthouse");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.thread_id).toBe(ownThread.id);

    const own = await readAgentConversation({ pool: env!.db, store }, agent.id, owner.id, { threadId: ownThread.id });
    expect(own?.thread_title).toBe(ownThread.title);
    expect(
      await readAgentConversation({ pool: env!.db, store }, agent.id, owner.id, { threadId: otherThread.id }),
    ).toBeNull();
  });

  it("search and read never reach another user's threads with a shared agent", async () => {
    const res = await env!.db.query(
      `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
       VALUES ($1, $2, 'agents-tools-peer@example.test', '', 'member', 'managed')
       RETURNING id`,
      [randomUUID(), orgId],
    );
    const peerId = res.rows[0]!.id as string;
    const peerThread = await store.threads.createThread(agent.id, peerId, "Peer thread", "user");
    await insertChunks(env!.db, [
      {
        thread_id: peerThread.id,
        agent_id: agent.id,
        seq_from: 1,
        seq_to: 2,
        text: "User: the peer's private harbour plan",
      },
    ]);
    expect(await searchAgentConversations(env!.db, agent.id, owner.id, "harbour")).toEqual([]);
    expect(await searchAgentConversations(env!.db, agent.id, peerId, "harbour")).toHaveLength(1);
    expect(
      await readAgentConversation({ pool: env!.db, store }, agent.id, owner.id, { threadId: peerThread.id }),
    ).toBeNull();
    expect(
      await readAgentConversation({ pool: env!.db, store }, agent.id, peerId, { threadId: peerThread.id }),
    ).not.toBeNull();
  });
});
