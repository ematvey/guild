// Delegation limits, authorization, child execution and artifact transfer.

import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "../../platform/store/identity.js";
import { ThreadStore } from "../../platform/store/thread.js";
import { AgentStore } from "../../agents/store.js";
import {
  authorizeDelegation,
  delegate,
  delegationContextForChat,
  DelegationError,
  releaseArtifacts,
  transferArtifacts,
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
  let root: string;

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
    root = await mkdtemp(path.join(tmpdir(), "guild-delegation-"));
  }, 60_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
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

  it("runs the child in a routine_run thread and copies declared artifacts to the inbox", async () => {
    const thread = await store.createThread(parentAgent.id, owner.id, "Delegation flow");
    const parentRun = await makeRun({ agentId: parentAgent.id, threadId: thread.id });
    const targetRoot = path.join(root, "agents", orgId, targetAgent.id);
    await mkdir(targetRoot, { recursive: true });
    await writeFile(path.join(targetRoot, "report.txt"), "the report\n");

    const runtime = {
      submitTurn: async (chatId: string): Promise<number> => {
        const child = await store.runningRunForChat(chatId);
        if (child === null) throw new Error("child run missing");
        await env!.db.query(
          `INSERT INTO agent_workspace_turns (id, agent_id, thread_id, run_id, started_at, finished_at, paths)
           VALUES ($1, $2, $3, $4, now(), now(), $5::text[])`,
          [randomUUID(), targetAgent.id, child.thread_id, child.id, ["report.txt"]],
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
      workspaceRoot: root,
      stagingRoot: path.join(root, "staging"),
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
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]!.status).toBe("inbox");
    const copied = path.join(root, "agents", orgId, parentAgent.id, "inbox", result.run_id, "report.txt");
    expect(await readFile(copied, "utf8")).toBe("the report\n");
    expect(await store.childRuns(parentRun.id)).toHaveLength(1);
    const artifacts = await store.listArtifacts(result.run_id);
    expect(artifacts[0]).toMatchObject({ status: "inbox", inbox_path: `inbox/${result.run_id}/report.txt` });
  });

  it("stages files over the threshold and release_artifacts deletes the staging dir", async () => {
    const thread = (await store.listThreads(parentAgent.id, owner.id))[0]!;
    const parentRun = await makeRun({ agentId: parentAgent.id, threadId: thread.id });
    const childRun = await makeRun({
      agentId: targetAgent.id,
      threadId: thread.id,
      parentRunId: parentRun.id,
      depth: 1,
    });
    const childRoot = path.join(root, "child-artifacts");
    const parentRoot = path.join(root, "parent-artifacts");
    const stagingRoot = path.join(root, "staging-artifacts");
    await mkdir(childRoot, { recursive: true });
    await writeFile(path.join(childRoot, "small.txt"), "small");
    await writeFile(path.join(childRoot, "large.bin"), "this is large");
    const artifacts = await transferArtifacts({
      store,
      parentAgentId: parentAgent.id,
      parentRunId: parentRun.id,
      childRunId: childRun.id,
      childAgentId: targetAgent.id,
      childRoot,
      parentRoot,
      stagingRoot,
      declared: ["small.txt", "large.bin"],
      maxInboxBytes: 6,
    });
    expect(artifacts.find((item) => item.path === "small.txt")?.status).toBe("inbox");
    const staged = artifacts.find((item) => item.path === "large.bin");
    expect(staged?.status).toBe("staged");
    expect(staged?.staging_path).toContain(path.join(stagingRoot, childRun.id));
    expect((await stat(staged!.staging_path!)).size).toBeGreaterThan(0);
    const released = await releaseArtifacts(store, stagingRoot, childRun.id);
    expect(released.released).toHaveLength(1);
    expect(await stat(path.join(stagingRoot, childRun.id)).catch(() => null)).toBeNull();
    const rows = await store.listArtifacts(childRun.id);
    expect(rows.find((item) => item.path === "large.bin")?.status).toBe("released");
    expect(rows.find((item) => item.path === "small.txt")?.status).toBe("inbox");
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
      workspaceRoot: root,
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
