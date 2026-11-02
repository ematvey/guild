// Conversation search: chunking a completed turn, FTS retrieval, agent
// scoping and the result bounds.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "../../platform/store/identity.js";
import { AgentStore } from "../../agents/store.js";
import { chunkThread, search } from "../../agents/search.js";
import { createAgentsTestEnv } from "./harness.js";
import type { M5TestEnv } from "../platform/m5-harness.js";

const env: M5TestEnv | null = await createAgentsTestEnv();
const dbDescribe = env === null ? describe.skip : describe;

dbDescribe("agent conversation search", () => {
  let store: AgentStore;
  let owner: UserRow;
  let agentId: string;
  let threadId: string;

  beforeAll(async () => {
    if (env === null) return;
    store = new AgentStore(env.db);
    const orgId = randomUUID();
    await env.db.query("INSERT INTO orgs (id, name) VALUES ($1, 'agents-search-org')", [orgId]);
    const userId = randomUUID();
    const res = await env.db.query(
      `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
       VALUES ($1, $2, 'agents-search@example.test', '', 'member', 'managed')
       RETURNING id, org_id, email, role, identity_type`,
      [userId, orgId],
    );
    owner = {
      ...(res.rows[0] as Omit<UserRow, "display_name" | "avatar_url" | "onboarded_at">),
      display_name: null,
      avatar_url: null,
      onboarded_at: null,
    };
    const agent = await store.create(owner, { name: "Search agent", model: "GLM-Test" });
    agentId = agent.id;
    threadId = (await store.listThreads(agent.id, owner.id)).threads[0]!.id;
  }, 60_000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("chunks a turn and finds it by FTS", async () => {
    await chunkThread(env!.db, {
      threadId,
      agentId,
      messages: [
        { seq: 1, role: "user", text: "How do I bake sourdough bread at home?" },
        { seq: 2, role: "assistant", text: "Mix flour and water, wait for the starter, then bake." },
        { seq: 3, role: "tool", text: "ignored tool output" },
      ],
    });
    const hits = await search(env!.db, { agentId, userId: owner.id, query: "bread" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.thread_id).toBe(threadId);
    expect(hits[0]!.seq_from).toBe(1);
    expect(hits[0]!.seq_to).toBe(2);
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(700);
    expect(hits[0]!.snippet).toContain("<mark>");
    expect(hits[0]!.rank).toBeGreaterThan(0);
  });

  it("scopes results to the agent and returns nothing for an empty query", async () => {
    const other = await store.create(owner, { name: "Other agent", model: "GLM-Test" });
    const otherThread = (await store.listThreads(other.id, owner.id)).threads[0]!.id;
    await chunkThread(env!.db, {
      threadId: otherThread,
      agentId: other.id,
      messages: [{ seq: 1, role: "user", text: "Bread belongs to the other agent." }],
    });
    const hits = await search(env!.db, { agentId, userId: owner.id, query: "bread" });
    expect(hits.every((hit) => hit.thread_id !== otherThread)).toBe(true);
    expect(await search(env!.db, { agentId, userId: owner.id, query: "   " })).toEqual([]);
  });

  it("caps results at 20 and honours a smaller limit", async () => {
    const bulk = await store.create(owner, { name: "Bulk agent", model: "GLM-Test" });
    const bulkThread = (await store.listThreads(bulk.id, owner.id)).threads[0]!.id;
    const chunks = Array.from({ length: 25 }, (_, index) => ({
      thread_id: bulkThread,
      agent_id: bulk.id,
      seq_from: index * 2 + 1,
      seq_to: index * 2 + 2,
      text: `User: bulkword uncommonterm${index}\n\nAssistant: reply ${index}`,
    }));
    await store.insertChunks(chunks);
    expect(await search(env!.db, { agentId: bulk.id, userId: owner.id, query: "bulkword" })).toHaveLength(20);
    expect(await search(env!.db, { agentId: bulk.id, userId: owner.id, query: "bulkword", limit: 5 })).toHaveLength(5);
  });
});
