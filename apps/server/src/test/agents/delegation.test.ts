// Delegation limits, authorization, child execution and sent-file ids.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "../../platform/store/identity.js";
import { ThreadStore } from "../../platform/store/thread.js";
import { AgentStore } from "../../agents/store.js";
import {
  authorizeDelegation,
  delegate,
  delegationContextForChat,
  DelegationError,
} from "../../agents/delegation.js";
import type { AgentRun } from "../../agents/types.js";
import { createAgentsTestEnv } from "./harness.js";
import type { M5TestEnv } from "../platform/m5-harness.js";

const env: M5TestEnv | null = await createAgentsTestEnv();
const dbDescribe = env === null ? describe.skip : describe;

async function makeUser(orgId: string, email: string, role = "member"): Promise<UserRow> {
  const res = await env!.db.query(
    `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
     VALUES ($1, $2, $3, '', $4, 'managed')
     RETURNING id, org_id, email, role, identity_type`,
    [randomUUID(), orgId, email, role],
  );
  return {
    ...(res.rows[0] as Omit<UserRow, "display_name" | "avatar_url" | "onboarded_at">),
    display_name: null,
    avatar_url: null,
    onboarded_at: null,
  };
}

dbDescribe("agent delegation", () => {
  let store: AgentStore;
  let threads: ThreadStore;
  let orgId: string;
  let owner: UserRow;
  let outsider: UserRow;
  let parentAgent: Awaited<ReturnType<AgentStore["create"]>>;
  let targetAgent: Awaited<ReturnType<AgentStore["create"]>>;
  let privateTarget: Awaited<ReturnType<AgentStore["create"]>>;

  async function makeRun(args: {
    agentId: string;
    threadId: string;
    depth?: number;
    parentRunId?: string | null;
    status?: AgentRun["status"];
  }): Promise<AgentRun> {
    return store.createRun({
      agent_id: args.agentId,
      thread_id: args.threadId,
      depth: args.depth ?? 0,
      parent_run_id: args.parentRunId ?? null,
      trigger: args.parentRunId === undefined || args.parentRunId === null ? "message" : "delegation",
      status: args.status ?? "running",
      started_at: new Date().toISOString(),
    });
  }

  beforeAll(async () => {
    if (env === null) return;
    store = new AgentStore(env.db);
    threads = new ThreadStore(env.db);
    orgId = randomUUID();
    await env.db.query("INSERT INTO orgs (id, name) VALUES ($1, 'agents-delegation-org')", [orgId]);
    owner = await makeUser(orgId, "delegation-owner@example.test");
    outsider = await makeUser(orgId, "delegation-outsider@example.test");
    parentAgent = await store.create(owner, { name: "Parent", model: "GLM-Test", visibility: "org" });
    targetAgent = await store.create(owner, { name: "Researcher", model: "GLM-Test", visibility: "org" });
    privateTarget = await store.create(outsider, { name: "Private", model: "GLM-Test", visibility: "private" });
  }, 60_000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("rejects self-delegation, depth, child count and cycles", async () => {
    const thread = (await store.listThreads(parentAgent.id, owner.id))[0]!;
    const run = await makeRun({ agentId: parentAgent.id, threadId: thread.id });
    const base = { pool: env!.db, store, agent: parentAgent, parentRun: run, requester: owner };

    await expect(authorizeDelegation({ ...base, targetRef: parentAgent.id })).rejects.toMatchObject({
      code: "self_delegation",
    });

    const deep = await makeRun({ agentId: parentAgent.id, threadId: thread.id, depth: 2 });
    await expect(
      authorizeDelegation({ ...base, parentRun: deep, targetRef: targetAgent.id }),
    ).rejects.toMatchObject({ code: "depth_limit" });

    const capped = await makeRun({ agentId: parentAgent.id, threadId: thread.id });
    for (let index = 0; index < 3; index += 1) {
      await makeRun({ agentId: targetAgent.id, threadId: thread.id, parentRunId: capped.id, depth: 1 });
    }
    await expect(
      authorizeDelegation({ ...base, parentRun: capped, targetRef: targetAgent.id }),
    ).rejects.toMatchObject({ code: "child_limit" });

    const rootRun = await makeRun({ agentId: targetAgent.id, threadId: thread.id });
    const childRun = await makeRun({
      agentId: parentAgent.id,
      threadId: thread.id,
      parentRunId: rootRun.id,
      depth: 1,
    });
    await expect(
      authorizeDelegation({ ...base, parentRun: childRun, targetRef: targetAgent.id }),
    ).rejects.toMatchObject({ code: "cycle" });
  });

  it("requires the requester to be able to use the target", async () => {
    const thread = (await store.listThreads(parentAgent.id, owner.id))[0]!;
    const run = await makeRun({ agentId: parentAgent.id, threadId: thread.id });
    const base = { pool: env!.db, store, agent: parentAgent, parentRun: run, requester: owner };
    await expect(
      authorizeDelegation({ ...base, targetRef: privateTarget.id }),
    ).rejects.toMatchObject({ code: "forbidden" });
    await env!.db.query(
      "INSERT INTO agent_grants (agent_id, user_id, role) VALUES ($1, $2, 'user')",
      [privateTarget.id, owner.id],
    );
    const target = await authorizeDelegation({ ...base, targetRef: privateTarget.name });
    expect(target.id).toBe(privateTarget.id);
  });

  it("runs the child in a routine_run thread and returns its text and sent file ids", async () => {
    const thread = await store.createThread(parentAgent.id, owner.id, "Delegation flow");
    const parentRun = await makeRun({ agentId: parentAgent.id, threadId: thread.id });
    const attachmentId = randomUUID();

    const runtime = {
      submitTurn: async (chatId: string): Promise<number> => {
        const child = await store.runningRunForChat(chatId);
        if (child === null) throw new Error("child run missing");
        await env!.db.query(
          `INSERT INTO attachments
             (id, org_id, chat_id, filename, content_type, size_bytes, object_key,
              author_kind, author_id, source_path)
           VALUES ($1, $2, $3, 'report.txt', 'text/plain', 11, $4, 'agent', $5, 'report.txt')`,
          [attachmentId, orgId, chatId, `attachments/${orgId}/${attachmentId}/report.txt`, targetAgent.id],
        );
        await store.updateRun(child.id, {
          status: "succeeded",
          summary: "The report is ready.",
          finished_at: new Date().toISOString(),
        });
        return 1;
      },
    };
    const context = await delegationContextForChat({
      pool: env!.db,
      store,
      threads,
      agent: parentAgent,
      chatId: thread.chat_id,
      runtime,
      timeoutMs: 2_000,
    });
    expect(context).not.toBeNull();
    const result = await delegate(context!, { agent: targetAgent.name, task: "Write the report" });
    const child = await store.getRun(result.run_id);
    expect(child.trigger).toBe("delegation");
    expect(child.depth).toBe(1);
    expect(child.parent_run_id).toBe(parentRun.id);
    expect(child.delegate_agent_id).toBe(targetAgent.id);
    const childThread = await store.getThread(targetAgent.id, owner.id, child.thread_id!);
    expect(childThread.kind).toBe("routine_run");
    expect(result.text).toBe("The report is ready.");
    expect(result.attachments).toEqual([attachmentId]);
    expect(await store.childRuns(parentRun.id)).toHaveLength(1);
  });

  it("exposes a structured error when the child run times out", async () => {
    const thread = await store.createThread(parentAgent.id, owner.id, "Delegation timeout");
    await makeRun({ agentId: parentAgent.id, threadId: thread.id });
    const context = await delegationContextForChat({
      pool: env!.db,
      store,
      threads,
      agent: parentAgent,
      chatId: thread.chat_id,
      runtime: { submitTurn: async () => 1 },
      timeoutMs: 50,
    });
    await expect(
      delegate(context!, { agent: targetAgent.name, task: "never finishes" }),
    ).rejects.toBeInstanceOf(DelegationError);
    await expect(
      delegate(context!, { agent: targetAgent.name, task: "never finishes" }),
    ).rejects.toMatchObject({ code: "timeout" });
  });
});
