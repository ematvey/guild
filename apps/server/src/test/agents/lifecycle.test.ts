// Agent run lifecycle: an agent_runs row is the copy of one pi-durable run.
// The run's first request opens it (taking over a queued row created for
// its input), run_end settles it once from the run's answer and indexes
// the turn, and a run with no text and no send_message is silent.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import type { UserRow } from "../../platform/store/identity.js";
import { AgentStore } from "../../agents/store.js";
import { ChatStore } from "../../platform/store/chats.js";
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
    store = new AgentStore({ pool: env.db, chats: new ChatStore(env.db) });
    threads = new ThreadStore(env.db);
    lifecycle = new AgentRunLifecycle({
      pool: env.db,
      log: pino({ level: "silent" }),
      runs: store.runs,
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
    const thread = (await store.threads.listThreads(agent.id, owner.id)).threads[0]!;
    threadId = thread.id;
    chatId = thread.chat_id;
  }, 60_000);

  afterAll(async () => {
    await env?.cleanup();
  });

  /** A submission whose request id names a pre-created run, as pi-durable
   *  records a delegated turn's input. */
  async function inputFor(requestId: string): Promise<number> {
    const id = Math.floor(Math.random() * 1e12);
    await env!.db.query(
      "INSERT INTO submissions(id, conversation_id, request_id, status, record) VALUES ($1, $2, $3, 'placed', '{}')",
      [id, id, JSON.stringify(requestId)],
    );
    return id;
  }

  async function openRuns(): Promise<{ id: string; status: string; trigger: string; user_id: string | null }[]> {
    const res = await env!.db.query<{ id: string; status: string; trigger: string; user_id: string | null }>(
      "SELECT id, status, trigger, user_id FROM agent_runs WHERE thread_id = $1 AND status IN ('queued', 'running') ORDER BY created_at",
      [threadId],
    );
    return res.rows;
  }

  function answer(step: number, text: string) {
    return assistantMessageEvent(
      1,
      step,
      [{ type: "text", text }],
      { tokens_in: 7, tokens_out: 5, cost_usd: 0 },
      "GLM-Test",
    );
  }

  it("opens a message run at the run's first request, once", async () => {
    await lifecycle.runStart(chatId, [1001]);
    await lifecycle.runStart(chatId, [1001]);
    // A process restarted mid-run resumes the same run: its row continues.
    const restarted = new AgentRunLifecycle({ pool: env!.db, log: pino({ level: "silent" }), runs: store.runs });
    await restarted.runStart(chatId, [1001]);
    const open = await openRuns();
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ status: "running", trigger: "message", user_id: owner.id });
    await lifecycle.runEnd(chatId, [1001], null);
    expect(await openRuns()).toHaveLength(0);
  });

  it("settles once with summary, tokens and a search chunk", async () => {
    await lifecycle.runStart(chatId, [1002]);
    const run = (await openRuns())[0]!;
    await threads.appendEvent(chatId, { type: "user_message", content: "What is bread?", attachments: [] });
    await threads.appendEvent(chatId, answer(1, "Bread is baked dough."));
    await lifecycle.runEnd(chatId, [1002], null);
    const done = await store.runs.getRun(run.id);
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
  });

  it("delivers the run's last answer, never tool narration nor an earlier answer", async () => {
    const delivered: ChildRunFinished[] = [];
    const withDelivery = new AgentRunLifecycle({
      pool: env!.db,
      log: pino({ level: "silent" }),
      runs: store.runs,
      delivery: {
        deliver: async (input) => {
          delivered.push(input);
        },
      },
    });
    await withDelivery.runStart(chatId, [1003]);
    const run = (await openRuns())[0]!;
    await threads.appendEvent(chatId, { type: "user_message", content: "Find the answer.", attachments: [] });
    await threads.appendEvent(
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
    // An answer, then a steer taken in the same run, then the real answer:
    // the run is still going after its first answer.
    await threads.appendEvent(chatId, answer(2, "The answer is 41."));
    await withDelivery.runStart(chatId, [1003]);
    expect(delivered).toHaveLength(0);
    expect((await store.runs.getRun(run.id)).status).toBe("running");
    await threads.appendEvent(chatId, answer(3, "Corrected: the answer is 42."));
    await withDelivery.runEnd(chatId, [1003], null);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.final_text).toBe("Corrected: the answer is 42.");
    expect((await store.runs.getRun(run.id)).status).toBe("succeeded");
  });

  it("takes over the queued run created for its input", async () => {
    const queued = await store.runs.createRun({ agent_id: agentId, thread_id: threadId, trigger: "delegation" });
    const other = await store.runs.createRun({ agent_id: agentId, thread_id: threadId, trigger: "delegation" });
    const input = await inputFor(queued.id);
    await lifecycle.runStart(chatId, [input]);
    expect((await store.runs.getRun(queued.id)).status).toBe("running");
    expect((await store.runs.getRun(other.id)).status).toBe("queued");
    expect((await openRuns()).filter((run) => run.trigger === "message")).toHaveLength(0);
    await lifecycle.runEnd(chatId, [input], null);
    expect((await store.runs.getRun(queued.id)).status).toBe("silent");
    // The other turn's run is taken by the run that places its input.
    const next = await inputFor(other.id);
    await lifecycle.runStart(chatId, [next]);
    await lifecycle.runEnd(chatId, [next], null);
    expect((await store.runs.getRun(other.id)).status).toBe("silent");
  });

  it("settles a queued run whose run ended before any request, and records a failed one", async () => {
    const queued = await store.runs.createRun({ agent_id: agentId, thread_id: threadId, trigger: "delegation" });
    const input = await inputFor(queued.id);
    await lifecycle.runEnd(chatId, [input], "model unavailable");
    const failed = await store.runs.getRun(queued.id);
    expect(failed.status).toBe("failed");
    expect(failed.error_message).toBe("model unavailable");

    await lifecycle.runEnd(chatId, [1004], "provider down");
    const recorded = await env!.db.query<{ status: string }>(
      "SELECT status FROM agent_runs WHERE thread_id = $1 AND error_message = 'provider down'",
      [threadId],
    );
    expect(recorded.rows.map((row) => row.status)).toEqual(["failed"]);
    // A run that ends cleanly before any request leaves no row.
    await lifecycle.runEnd(chatId, [1005], null);
    expect(await openRuns()).toHaveLength(0);
  });

  it("marks a run with no text and no send_message silent", async () => {
    await lifecycle.runStart(chatId, [1006]);
    const run = (await openRuns())[0]!;
    await lifecycle.runEnd(chatId, [1006], null);
    const done = await store.runs.getRun(run.id);
    expect(done.status).toBe("silent");
    expect(done.summary).toBeNull();
  });
});
