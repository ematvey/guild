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
      { pool: env!.db, store, threads, agent },
      { text: "The report is ready." },
    );
    const thread = await store.getThread(agent.id, result.thread_id);
    expect(thread.title).toBe("The report is ready.");
    expect(result.url).toBe(`/agents/${agent.id}/threads/${thread.id}`);
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

  it("registers schedule_reminder for agent conversations", () => {
    const tools = createAgentTools({ pool: env!.db, store, threads, agent });
    expect(tools.map((tool) => tool.name)).toContain("schedule_reminder");
  });

  it("search and read are scoped to the calling agent", async () => {
    const ownThread = (await store.listThreads(agent.id))[0]!;
    const otherThread = (await store.listThreads(other.id))[0]!;
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
