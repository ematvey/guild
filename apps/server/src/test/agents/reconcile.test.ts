// Stale-run reconciliation: a run whose chat has no recent event belongs to
// a dead process, so it is failed and its parent strip is settled.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import { AgentStore } from "../../agents/store.js";
import { ChatStore } from "../../platform/store/chats.js";
import { failStaleRuns } from "../../agents/reconcile.js";
import type { ChildRunFinished } from "../../agents/delivery.js";
import { ThreadStore } from "../../platform/store/thread.js";
import { createAgentsTestEnv } from "./harness.js";
import type { HubTestEnv } from "../support/hub-env.js";

const env: HubTestEnv | null = await createAgentsTestEnv();
const dbDescribe = env === null ? describe.skip : describe;

dbDescribe("stale run reconciliation", () => {
  let store: AgentStore;
  let threads: ThreadStore;
  let orgId: string;
  let userId: string;
  const stopped: string[] = [];
  const redelivered: string[] = [];
  const delivered: ChildRunFinished[] = [];
  const deps = () => ({
    pool: env!.db,
    runtime: {
      stopChat: async (chatId: string) => {
        stopped.push(chatId);
      },
      canStopChat: () => true,
      deliverChildResult: async (input: ChildRunFinished) => {
        delivered.push(input);
      },
      deliverPending: async (chatId: string) => {
        redelivered.push(chatId);
        return true;
      },
    },
    log: pino({ level: "silent" }),
  });

  beforeAll(async () => {
    if (env === null) return;
    store = new AgentStore({ pool: env.db, chats: new ChatStore(env.db) });
    threads = new ThreadStore(env.db);
    orgId = randomUUID();
    userId = randomUUID();
    await env.db.query("INSERT INTO orgs (id, name) VALUES ($1, $2)", [orgId, "reconcile-org"]);
    await env.db.query(
      `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
       VALUES ($1, $2, 'reconcile@example.test', '', 'member', 'managed')`,
      [userId, orgId],
    );
  }, 60_000);

  afterAll(async () => {
    await env?.cleanup();
  });

  interface Fixture {
    parentChatId: string;
    childChatId: string;
    childThreadId: string;
    runId: string;
  }

  async function fixture(options: { ageMs: number | null; closed?: boolean }): Promise<Fixture> {
    const agent = await store.create(
      {
        id: userId,
        org_id: orgId,
        email: "reconcile@example.test",
        role: "member",
        identity_type: "managed",
        display_name: null,
        avatar_url: null,
        onboarded_at: null,
      },
      { name: `Agent ${randomUUID().slice(0, 8)}`, model: "GLM-Test" },
    );
    const parent = (await store.threads.listThreads(agent.id, userId)).threads[0]!;
    const child = await store.threads.createChildThread(parent.id, agent.id, userId, "Child task");
    const run = await store.runs.createRun({
      agent_id: agent.id,
      user_id: userId,
      thread_id: child.id,
      parent_run_id: null,
      delegate_agent_id: agent.id,
      depth: child.depth,
      trigger: "delegation",
      status: "running",
      started_at: new Date().toISOString(),
    });
    await threads.appendEvent(child.chat_id, { type: "user_message", content: "work", attachments: [] });
    if (options.ageMs !== null) {
      await env!.db.query(
        "UPDATE thread_events SET created_at = now() - ($2::bigint * interval '1 millisecond') WHERE chat_id = $1",
        [child.chat_id, options.ageMs],
      );
    }
    if (options.closed === true) {
      await env!.db.query("UPDATE agent_threads SET closed_at = now() WHERE id = $1", [child.id]);
    }
    return {
      parentChatId: parent.chat_id,
      childChatId: child.chat_id,
      childThreadId: child.id,
      runId: run.id,
    };
  }

  /** The results the sweep handed to delivery for one child run. */
  async function childResults(_chatId: string, runId: string): Promise<ChildRunFinished[]> {
    return delivered.filter((input) => input.run_id === runId);
  }

  /** Ends a fixture's child run as succeeded, `ageMs` ago. */
  async function finishRun(runId: string, ageMs: number): Promise<void> {
    await env!.db.query(
      "UPDATE agent_runs SET status = 'succeeded', finished_at = now() - ($2::bigint * interval '1 millisecond') WHERE id = $1",
      [runId, ageMs],
    );
  }

  it("fails an old run and settles the parent strip", async () => {
    const fx = await fixture({ ageMs: 20 * 60 * 1000 });
    const failed = await failStaleRuns(deps());
    expect(failed).toBe(1);

    const run = await store.runs.getRun(fx.runId);
    expect(run.status).toBe("failed");
    expect(run.error_code).toBe("orphaned");

    const results = await childResults(fx.parentChatId, fx.runId);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      child_thread_id: fx.childThreadId,
      run_id: fx.runId,
      status: "failed",
      reason: "orphaned",
      final_text: "",
    });
    expect(stopped).toContain(fx.childChatId);
  });

  it("leaves a run with a fresh event untouched", async () => {
    const fx = await fixture({ ageMs: null });
    await failStaleRuns(deps());
    expect((await store.runs.getRun(fx.runId)).status).toBe("running");
    expect(await childResults(fx.parentChatId, fx.runId)).toHaveLength(0);
  });

  it("leaves a quiet run alone while its chat holds durable work", async () => {
    const fx = await fixture({ ageMs: 20 * 60 * 1000 });
    // A turn waiting on an approval: quiet, but its generation task is live.
    const conversationId = Math.floor(Math.random() * 1e12);
    await env!.db.query("INSERT INTO chat_conversations (chat_id, conversation_id) VALUES ($1, $2)", [
      fx.childChatId,
      conversationId,
    ]);
    await env!.db.query(
      `INSERT INTO tasks (id, conversation_id, kind, status, abort_requested, background, record)
       VALUES ($1, $2, '"pi.generation"', 'waiting', false, false, '{}')`,
      [conversationId, conversationId],
    );
    await failStaleRuns(deps());
    expect((await store.runs.getRun(fx.runId)).status).toBe("running");
    expect(stopped).not.toContain(fx.childChatId);
  });

  it("fails a closed child without a parent child_result", async () => {
    const fx = await fixture({ ageMs: 20 * 60 * 1000, closed: true });
    await failStaleRuns(deps());
    expect((await store.runs.getRun(fx.runId)).status).toBe("failed");
    expect(await childResults(fx.parentChatId, fx.runId)).toHaveLength(0);
  });

  it("fails nothing new on a second call", async () => {
    const fx = await fixture({ ageMs: 20 * 60 * 1000 });
    expect(await failStaleRuns(deps())).toBe(1);
    expect(await failStaleRuns(deps())).toBe(0);
    expect((await store.runs.getRun(fx.runId)).status).toBe("failed");
  });

  it("redelivers a child result that never reached the parent's conversation", async () => {
    const fx = await fixture({ ageMs: null });
    await finishRun(fx.runId, 5 * 60 * 1000);
    redelivered.length = 0;
    await failStaleRuns(deps());
    expect(redelivered).toContain(fx.parentChatId);
  });

  it("leaves a fresh result to its own delivery, and a delivered one alone", async () => {
    const fresh = await fixture({ ageMs: null });
    await finishRun(fresh.runId, 0);
    const shown = await fixture({ ageMs: null });
    await finishRun(shown.runId, 5 * 60 * 1000);
    await threads.appendEvent(shown.parentChatId, {
      type: "child_result",
      thread_id: shown.childThreadId,
      run_id: shown.runId,
      chat_id: shown.childChatId,
      agent_name: "Clients",
      title: "Child task",
      status: "succeeded",
      final_text: "the answer",
      attachments: [],
    });
    redelivered.length = 0;
    await failStaleRuns(deps());
    expect(redelivered).not.toContain(fresh.parentChatId);
    expect(redelivered).not.toContain(shown.parentChatId);
  });
});
