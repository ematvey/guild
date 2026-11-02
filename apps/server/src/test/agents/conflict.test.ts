// Workspace conflict journal: two running turns on overlapping paths, with
// the notice delivered as a system_message in the other thread.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "../../platform/store/identity.js";
import { ThreadStore } from "../../platform/store/thread.js";
import { AgentStore } from "../../agents/store.js";
import { ChatStore } from "../../platform/store/chats.js";
import { AgentConflictJournal, workspaceTurnForRun, writtenPaths } from "../../agents/conflict.js";
import { createAgentsTestEnv } from "./harness.js";
import type { HubTestEnv } from "../support/hub-env.js";

const env: HubTestEnv | null = await createAgentsTestEnv();
const dbDescribe = env === null ? describe.skip : describe;

dbDescribe("agent workspace conflict journal", () => {
  let store: AgentStore;
  let threads: ThreadStore;
  let journal: AgentConflictJournal;
  let orgId: string;
  let owner: UserRow;
  let agent: Awaited<ReturnType<AgentStore["create"]>>;

  beforeAll(async () => {
    if (env === null) return;
    store = new AgentStore({ pool: env.db, chats: new ChatStore(env.db) });
    threads = new ThreadStore(env.db);
    journal = new AgentConflictJournal({ pool: env.db, store, threads });
    orgId = randomUUID();
    await env.db.query("INSERT INTO orgs (id, name) VALUES ($1, 'agents-conflict-org')", [orgId]);
    const res = await env.db.query(
      `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
       VALUES ($1, $2, 'agents-conflict@example.test', '', 'member', 'managed')
       RETURNING id, org_id, email, role, identity_type`,
      [randomUUID(), orgId],
    );
    owner = {
      ...(res.rows[0] as Omit<UserRow, "display_name" | "avatar_url" | "onboarded_at">),
      display_name: null,
      avatar_url: null,
      onboarded_at: null,
    };
    agent = await store.create(owner, { name: "Journal", model: "GLM-Test" });
  }, 60_000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("parses write, edit, apply_patch and simple shell writes", () => {
    expect(writtenPaths("write", { path: "src/a.ts" })).toEqual(["src/a.ts"]);
    expect(writtenPaths("edit", { path: "./src/b.ts" })).toEqual(["src/b.ts"]);
    expect(
      writtenPaths("apply_patch", { patch: "*** Update File: docs/spec.md\n*** Add File: notes/todo.md" }),
    ).toEqual(["docs/spec.md", "notes/todo.md"]);
    expect(writtenPaths("bash", { command: "echo hi > out.txt && tee -a logs/run.log" })).toEqual([
      "out.txt",
      "logs/run.log",
    ]);
    expect(writtenPaths("bash", { command: "cat /etc/passwd" })).toEqual([]);
  });

  it("notifies the other running turn and finishes the journal row", async () => {
    const firstThread = await store.threads.createThread(agent.id, owner.id, "First turn");
    const secondThread = await store.threads.createThread(agent.id, owner.id, "Second turn");
    const firstRun = await store.runs.createRun({
      agent_id: agent.id,
      thread_id: firstThread.id,
      trigger: "message",
      status: "running",
      started_at: new Date().toISOString(),
    });
    const secondRun = await store.runs.createRun({
      agent_id: agent.id,
      thread_id: secondThread.id,
      trigger: "message",
      status: "running",
      started_at: new Date().toISOString(),
    });
    await journal.beginTurn(firstThread.chat_id);
    await journal.beginTurn(secondThread.chat_id);
    expect(await journal.recordToolCall(firstThread.chat_id, "write", { path: "shared.txt" })).toBeNull();
    const notice = await journal.recordToolCall(secondThread.chat_id, "write", { path: "shared.txt" });
    expect(notice).toContain("First turn");
    expect(notice).toContain("shared.txt");

    const events = await threads.listEvents(orgId, firstThread.chat_id);
    const system = events.find((row) => row.event.type === "system_message");
    expect(system).toBeDefined();
    expect((system!.event as { content: string }).content).toContain("Second turn");
    expect((system!.event as { content: string }).content).toContain("shared.txt");
    const notices = await store.notices.listNotices(owner.id, orgId);
    expect(notices.some((item) => item.kind === "workspace_conflict")).toBe(false);

    await journal.finishRun(firstRun.id);
    await journal.finishRun(secondRun.id);
    expect((await workspaceTurnForRun(env!.db, firstRun.id))?.finished).toBe(true);
    expect((await workspaceTurnForRun(env!.db, secondRun.id))?.finished).toBe(true);
  });
});
