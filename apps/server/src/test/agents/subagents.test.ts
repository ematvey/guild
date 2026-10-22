// Subagent tree tools: spawn, send, read, list, cancel and close, with the
// depth and per-node child limits and the subtree rules.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "../../platform/store/identity.js";
import { ThreadStore } from "../../platform/store/thread.js";
import { userMessageEvent } from "../../platform/domain/thread-events.js";
import { AgentStore } from "../../agents/store.js";
import {
  cancel,
  close,
  list,
  read,
  send,
  spawn,
  subagentsContextForChat,
  type SubagentsRuntime,
  type SubagentsToolContext,
} from "../../agents/subagents.js";
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

interface FakeRuntime {
  runtime: SubagentsRuntime;
  submitted: { chatId: string; content: string }[];
  stopped: string[];
}

function fakeRuntime(overrides: Partial<SubagentsRuntime> = {}): FakeRuntime {
  const submitted: { chatId: string; content: string }[] = [];
  const stopped: string[] = [];
  return {
    submitted,
    stopped,
    runtime: {
      submitTurn: async (chatId, _orgId, input) => {
        submitted.push({ chatId, content: input.content });
        return 1;
      },
      stopChat: async (chatId) => {
        stopped.push(chatId);
      },
      canStopChat: () => true,
      ...overrides,
    },
  };
}

dbDescribe("subagent tree tools", () => {
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

  async function contextFor(args: {
    thread: { id: string; chat_id: string };
    run: AgentRun;
    fake: FakeRuntime;
    maxDepth?: number;
    maxChildrenPerNode?: number;
  }): Promise<SubagentsToolContext> {
    const context = await subagentsContextForChat({
      pool: env!.db,
      store,
      agent: parentAgent,
      chatId: args.thread.chat_id,
      runtime: args.fake.runtime,
      maxDepth: args.maxDepth ?? 3,
      maxChildrenPerNode: args.maxChildrenPerNode ?? 16,
    });
    expect(context).not.toBeNull();
    expect(context!.parentRun.id).toBe(args.run.id);
    return context!;
  }

  beforeAll(async () => {
    if (env === null) return;
    store = new AgentStore(env.db);
    threads = new ThreadStore(env.db);
    orgId = randomUUID();
    await env.db.query("INSERT INTO orgs (id, name) VALUES ($1, 'agents-subagents-org')", [orgId]);
    owner = await makeUser(orgId, "subagents-owner@example.test");
    outsider = await makeUser(orgId, "subagents-outsider@example.test");
    parentAgent = await store.create(owner, { name: "Parent", model: "GLM-Test", visibility: "org" });
    targetAgent = await store.create(owner, { name: "Researcher", model: "GLM-Test", visibility: "org" });
    privateTarget = await store.create(outsider, { name: "Private", model: "GLM-Test", visibility: "private" });
  }, 60_000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("spawn creates the child thread and run, posts the task and returns at once", async () => {
    const thread = await store.createThread(parentAgent.id, owner.id, "Spawn flow");
    const parentRun = await makeRun({ agentId: parentAgent.id, threadId: thread.id });
    const fake = fakeRuntime();
    const context = await contextFor({ thread, run: parentRun, fake });

    const result = await spawn(context, { agent: targetAgent.name, task: "Write the report" });
    const childRun = await store.getRun(result.run_id);
    expect(childRun.status).toBe("running");
    expect(childRun.trigger).toBe("delegation");
    expect(childRun.depth).toBe(1);
    expect(childRun.parent_run_id).toBe(parentRun.id);
    expect(childRun.delegate_agent_id).toBe(targetAgent.id);

    const childThread = await store.threadById(result.thread_id);
    expect(childThread?.kind).toBe("delegated");
    expect(childThread?.parent_thread_id).toBe(thread.id);
    expect(childThread?.depth).toBe(1);
    expect(childThread?.closed_at).toBeNull();
    expect(fake.submitted).toEqual([{ chatId: childThread!.chat_id, content: "Write the report" }]);
  });

  it("enforces the depth and per-node child limits", async () => {
    const root = await store.createThread(parentAgent.id, owner.id, "Limits");
    const depth1 = await store.createChildThread(root.id, targetAgent.id, owner.id, "Depth 1");
    const depth2 = await store.createChildThread(depth1.id, targetAgent.id, owner.id, "Depth 2");
    const depth3 = await store.createChildThread(depth2.id, targetAgent.id, owner.id, "Depth 3");
    const deepRun = await makeRun({ agentId: parentAgent.id, threadId: depth3.id, depth: 3 });
    const fake = fakeRuntime();
    const deepContext = await contextFor({ thread: depth3, run: deepRun, fake });
    await expect(spawn(deepContext, { agent: targetAgent.name, task: "too deep" })).rejects.toMatchObject({
      code: "depth_limit",
    });

    const cappedThread = await store.createThread(parentAgent.id, owner.id, "Child cap");
    const cappedRun = await makeRun({ agentId: parentAgent.id, threadId: cappedThread.id });
    for (let index = 0; index < 16; index += 1) {
      await store.createChildThread(cappedThread.id, targetAgent.id, owner.id, `Child ${index}`);
    }
    const cappedContext = await contextFor({ thread: cappedThread, run: cappedRun, fake });
    await expect(spawn(cappedContext, { agent: targetAgent.name, task: "one too many" })).rejects.toMatchObject({
      code: "child_limit",
    });
  });

  it("requires the requester to be able to use the target agent", async () => {
    const thread = await store.createThread(parentAgent.id, owner.id, "Access");
    const run = await makeRun({ agentId: parentAgent.id, threadId: thread.id });
    const fake = fakeRuntime();
    const context = await contextFor({ thread, run, fake });
    await expect(spawn(context, { agent: privateTarget.name, task: "secret" })).rejects.toMatchObject({
      code: "forbidden",
    });
  });

  it("send posts a turn and rejects a closed, foreign or self thread", async () => {
    const thread = await store.createThread(parentAgent.id, owner.id, "Send");
    const parentRun = await makeRun({ agentId: parentAgent.id, threadId: thread.id });
    const fake = fakeRuntime();
    const context = await contextFor({ thread, run: parentRun, fake });
    const child = await spawn(context, { agent: targetAgent.name, task: "start" });

    const sent = await send(context, { thread_id: child.thread_id, text: "next step" });
    const run = await store.getRun(sent.run_id);
    expect(run.thread_id).toBe(child.thread_id);
    expect(run.parent_run_id).toBe(parentRun.id);
    expect(fake.submitted.at(-1)).toEqual({ chatId: (await store.threadById(child.thread_id))!.chat_id, content: "next step" });

    await store.closeSubtree(child.thread_id);
    await expect(send(context, { thread_id: child.thread_id, text: "too late" })).rejects.toMatchObject({
      code: "closed_thread",
    });

    const foreign = await store.createThread(targetAgent.id, owner.id, "Foreign");
    await expect(send(context, { thread_id: foreign.id, text: "not mine" })).rejects.toMatchObject({
      code: "not_descendant",
    });
    await expect(send(context, { thread_id: thread.id, text: "self" })).rejects.toMatchObject({
      code: "not_descendant",
    });
  });

  it("read returns a bounded excerpt of a descendant thread", async () => {
    const thread = await store.createThread(parentAgent.id, owner.id, "Read");
    const parentRun = await makeRun({ agentId: parentAgent.id, threadId: thread.id });
    const fake = fakeRuntime();
    const context = await contextFor({ thread, run: parentRun, fake });
    const child = await spawn(context, { agent: targetAgent.name, task: "start" });
    const childThread = await store.threadById(child.thread_id);
    await threads.appendEvent(childThread!.chat_id, userMessageEvent("the first line"));
    await threads.appendEvent(childThread!.chat_id, userMessageEvent("the second line"));

    const excerpt = await read(context, { thread_id: child.thread_id });
    expect(excerpt.thread_id).toBe(child.thread_id);
    expect(excerpt.thread_title).toBe(childThread!.title);
    expect(excerpt.events.map((event) => event.text)).toContain("the first line");
    expect(excerpt.events.map((event) => event.text)).toContain("the second line");
    expect(excerpt.truncated).toBe(false);
  });

  it("list reports direct children with status, depth and elapsed", async () => {
    const thread = await store.createThread(parentAgent.id, owner.id, "List");
    const parentRun = await makeRun({ agentId: parentAgent.id, threadId: thread.id });
    const fake = fakeRuntime();
    const context = await contextFor({ thread, run: parentRun, fake });
    const child = await spawn(context, { agent: targetAgent.name, task: "start" });
    const grandchildThread = await store.createChildThread(child.thread_id, targetAgent.id, owner.id, "Grandchild");
    await makeRun({ agentId: targetAgent.id, threadId: grandchildThread.id, depth: 2, parentRunId: (await store.getRun(child.run_id)).id });

    const children = await list(context);
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({
      thread_id: child.thread_id,
      agent_name: targetAgent.name,
      status: "running",
      depth: 1,
      closed: false,
    });
    expect(children[0]!.elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it("cancel stops in-flight runs in the subtree and keeps the nodes open", async () => {
    const thread = await store.createThread(parentAgent.id, owner.id, "Cancel");
    const parentRun = await makeRun({ agentId: parentAgent.id, threadId: thread.id });
    const fake = fakeRuntime();
    const context = await contextFor({ thread, run: parentRun, fake });
    const child = await spawn(context, { agent: targetAgent.name, task: "start" });
    const childThread = await store.threadById(child.thread_id);
    const grandchildThread = await store.createChildThread(child.thread_id, targetAgent.id, owner.id, "Grandchild");
    const grandchildRun = await makeRun({
      agentId: targetAgent.id,
      threadId: grandchildThread.id,
      depth: 2,
      parentRunId: child.run_id,
    });

    const result = await cancel(context, { thread_id: child.thread_id });
    expect(result.cancelled).toBe(2);
    expect((await store.getRun(child.run_id)).status).toBe("cancelled");
    expect((await store.getRun(grandchildRun.id)).status).toBe("cancelled");
    expect((await store.threadById(child.thread_id))?.closed_at).toBeNull();
    expect((await store.threadById(grandchildThread.id))?.closed_at).toBeNull();
    expect(new Set(fake.stopped)).toEqual(new Set([childThread!.chat_id, grandchildThread.chat_id]));
  });

  it("cancel fails before any mutation when a worker cannot reach the chat", async () => {
    const thread = await store.createThread(parentAgent.id, owner.id, "Cancel remote");
    const parentRun = await makeRun({ agentId: parentAgent.id, threadId: thread.id });
    const fake = fakeRuntime({ canStopChat: () => false });
    const context = await contextFor({ thread, run: parentRun, fake });
    const child = await spawn(context, { agent: targetAgent.name, task: "start" });

    await expect(cancel(context, { thread_id: child.thread_id })).rejects.toMatchObject({
      code: "cancel_unreachable",
    });
    expect((await store.getRun(child.run_id)).status).toBe("running");
    expect(fake.stopped).toHaveLength(0);
  });

  it("close cancels the subtree and stamps closed_at on every node", async () => {
    const thread = await store.createThread(parentAgent.id, owner.id, "Close");
    const parentRun = await makeRun({ agentId: parentAgent.id, threadId: thread.id });
    const fake = fakeRuntime();
    const context = await contextFor({ thread, run: parentRun, fake });
    const child = await spawn(context, { agent: targetAgent.name, task: "start" });
    const grandchildThread = await store.createChildThread(child.thread_id, targetAgent.id, owner.id, "Grandchild");
    await makeRun({
      agentId: targetAgent.id,
      threadId: grandchildThread.id,
      depth: 2,
      parentRunId: child.run_id,
    });

    const result = await close(context, { thread_id: child.thread_id });
    expect(result.closed).toBe(2);
    expect(result.cancelled).toBe(2);
    expect((await store.threadById(child.thread_id))?.closed_at).not.toBeNull();
    expect((await store.threadById(grandchildThread.id))?.closed_at).not.toBeNull();
    expect((await store.getRun(child.run_id)).status).toBe("cancelled");
  });
});
