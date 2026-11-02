// Agent run lifecycle: a terminal assistant event completes the run once,
// indexes the turn, and a run with no text and no send_message is silent.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import type { UserRow } from "../../platform/store/identity.js";
import { AgentStore } from "../../agents/store.js";
import { AgentRunLifecycle } from "../../agents/lifecycle.js";
import { ThreadStore } from "../../platform/store/thread.js";
import { assistantMessageEvent } from "../../platform/domain/thread-events.js";
import { createAgentsTestEnv } from "./harness.js";
import type { HubTestEnv } from "../support/hub-env.js";
import type { ChildRunFinished } from "../../agents/delivery.js";

const env: HubTestEnv | null = await createAgentsTestEnv();
const dbDescribe = env === null ? describe.skip : describe;

dbDescribe("agent run lifecycle", () => {
  let store: AgentStore;
  let threads: ThreadStore;
  let lifecycle: AgentRunLifecycle;
  let owner: UserRow;
  let orgId: string;
  let agentId: string;
  let threadId: string;
  let chatId: string;

  beforeAll(async () => {
    if (env === null) return;
    store = new AgentStore(env.db);
    threads = new ThreadStore(env.db);
    lifecycle = new AgentRunLifecycle({
      pool: env.db,
      log: pino({ level: "silent" }),
    });
    orgId = randomUUID();
    await env.db.query("INSERT INTO orgs (id, name) VALUES ($1, 'agents-lifecycle-org')", [orgId]);
    const id = randomUUID();
    const res = await env.db.query(
      `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
       VALUES ($1, $2, 'agents-lifecycle@example.test', '', 'member', 'managed')
       RETURNING id, org_id, email, role, identity_type`,
      [id, orgId],
    );
    owner = {
      ...(res.rows[0] as Omit<UserRow, "display_name" | "avatar_url" | "onboarded_at">),
      display_name: null,
      avatar_url: null,
      onboarded_at: null,
    };
    const agent = await store.create(owner, { name: "Lifecycle", model: "GLM-Test" });
    agentId = agent.id;
    const thread = (await store.listThreads(agent.id, owner.id)).threads[0]!;
    threadId = thread.id;
    chatId = thread.chat_id;
  }, 60_000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("completes once with summary, tokens and a search chunk", async () => {
    const run = await store.createRun({
      agent_id: agentId,
      thread_id: threadId,
      trigger: "message",
      status: "running",
      started_at: new Date().toISOString(),
    });
    await threads.appendEvent(chatId, { type: "user_message", content: "What is bread?", attachments: [] });
    const row = await threads.appendEvent(
      chatId,
      assistantMessageEvent(
        1,
        1,
        [{ type: "text", text: "Bread is baked dough." }],
        { tokens_in: 7, tokens_out: 5, cost_usd: 0 },
        "GLM-Test",
      ),
    );
    await lifecycle.assistantEvent(chatId, row);
    const done = await store.getRun(run.id);
    expect(done.status).toBe("succeeded");
    expect(done.summary).toBe("Bread is baked dough.");
    expect(done.tokens).toBe(12);
    expect(done.finished_at).not.toBeNull();

    const chunks = await env!.db.query<{ seq_from: number; seq_to: number; text: string }>(
      "SELECT seq_from, seq_to, text FROM agent_thread_chunks WHERE thread_id = $1",
      [threadId],
    );
    expect(chunks.rows).toHaveLength(1);
    expect(chunks.rows[0]!.text).toContain("What is bread?");
    expect(chunks.rows[0]!.seq_to).toBeGreaterThan(chunks.rows[0]!.seq_from);

    // A second report (the bridge's run_end) must not rewrite the run or
    // duplicate the chunk.
    await lifecycle.runEnd(chatId, null);
    expect((await store.getRun(run.id)).tokens).toBe(12);
    const again = await env!.db.query("SELECT id FROM agent_thread_chunks WHERE thread_id = $1", [threadId]);
    expect(again.rows).toHaveLength(1);
  });

  it("delivers only the terminal assistant text, never tool narration", async () => {
    const delivered: ChildRunFinished[] = [];
    const withDelivery = new AgentRunLifecycle({
      pool: env!.db,
      log: pino({ level: "silent" }),
      delivery: { deliver: async (input) => { delivered.push(input); } },
    });
    const run = await store.createRun({
      agent_id: agentId,
      thread_id: threadId,
      trigger: "message",
      status: "running",
      started_at: new Date().toISOString(),
    });
    await threads.appendEvent(chatId, { type: "user_message", content: "Find the answer.", attachments: [] });
    const narrated = await threads.appendEvent(
      chatId,
      assistantMessageEvent(
        1,
        1,
        [
          { type: "text", text: "I will check the files first." },
          { type: "tool_call", id: "call-1", name: "bash", arguments: "{}" },
        ],
        { tokens_in: 1, tokens_out: 1, cost_usd: 0 },
        "GLM-Test",
      ),
    );
    await withDelivery.assistantEvent(chatId, narrated);
    expect(delivered).toHaveLength(0);

    const terminal = await threads.appendEvent(
      chatId,
      assistantMessageEvent(
        1,
        2,
        [{ type: "text", text: "The answer is 42." }],
        { tokens_in: 1, tokens_out: 1, cost_usd: 0 },
        "GLM-Test",
      ),
    );
    await withDelivery.assistantEvent(chatId, terminal);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.final_text).toBe("The answer is 42.");
    expect((await store.getRun(run.id)).status).toBe("succeeded");
  });

  it("marks a run with no text and no send_message silent", async () => {
    const run = await store.createRun({
      agent_id: agentId,
      thread_id: threadId,
      trigger: "routine",
      status: "running",
      started_at: new Date().toISOString(),
    });
    await lifecycle.runEnd(chatId, null);
    const done = await store.getRun(run.id);
    expect(done.status).toBe("silent");
    expect(done.summary).toBeNull();
  });
});
