import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { guardMemoryTool } from "../../agents/conflict.js";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import { AgentCoordination, coordinationSettings, ensureCoordinationThread } from "../../agents/coordination.js";
import { expireReflectedInputContent } from "../../agents/store/coordination.js";
import { runTraceRow } from "../../agents/store/run-finish.js";
import { AgentStore } from "../../agents/store.js";
import { ChatStore } from "../../platform/store/chats.js";
import { ThreadStore } from "../../platform/store/thread.js";
import type { UserRow } from "../../platform/store/identity.js";
import type { Agent, AgentThread } from "../../agents/types.js";
import { createAgentsTestEnv } from "./harness.js";

const env = await createAgentsTestEnv();
const suite = env === null ? describe.skip : describe;

suite("persistent coordination", () => {
  let store: AgentStore;
  let chats: ChatStore;
  let threads: ThreadStore;
  let agent: Agent;
  let alice: UserRow;
  let bob: UserRow;
  const calls: { kind: string; chat: string; content: unknown }[] = [];
  let coordination: AgentCoordination;

  beforeAll(async () => {
    const orgId = randomUUID();
    await env!.db.query("INSERT INTO orgs(id,name) VALUES($1,'coordination')", [orgId]);
    const users = [];
    for (const name of ["alice", "bob"]) {
      const result = await env!.db.query(
        "INSERT INTO users(id,org_id,email,password_hash,role,identity_type,display_name) VALUES($1,$2,$3,'','member','managed',$4) RETURNING *",
        [randomUUID(), orgId, `${name}@example.test`, name],
      );
      users.push(result.rows[0] as UserRow);
    }
    [alice, bob] = users as [UserRow, UserRow];
    chats = new ChatStore(env!.db);
    threads = new ThreadStore(env!.db);
    store = new AgentStore({ pool: env!.db, chats });
    agent = await store.create(alice, {
      name: "Team assistant",
      model: "test",
      visibility: "org",
      resources: { assistant: { enabled: true } },
    });
    coordination = new AgentCoordination({
      pool: env!.db,
      store,
      log: pino({ level: "silent" }),
      runtime: {
        submitTurn: async (chat, _org, input) => {
          calls.push({ kind: "wake", chat, content: input.content });
          return 1;
        },
        writeEntry: async (chat, entry) => {
          calls.push({ kind: "observe", chat, content: entry });
        },
        compactChat: async () => null,
        stopChat: async () => {},
      },
    });
  });
  afterAll(async () => {
    coordination?.stop();
    await env?.cleanup();
  });

  it("creates one internal coordinator but distinct member-facing inboxes", async () => {
    const [a, b] = await Promise.all([
      ensureCoordinationThread(env!.db, store, agent, alice.id, "coordinator"),
      ensureCoordinationThread(env!.db, store, agent, bob.id, "coordinator"),
    ]);
    expect(a.id).toBe(b.id);
    await expect(chats.getChat(agent.org_id, a.chat_id, alice)).rejects.toThrow();
    const ia = await ensureCoordinationThread(env!.db, store, agent, alice.id, "inbox");
    const ib = await ensureCoordinationThread(env!.db, store, agent, bob.id, "inbox");
    expect(ia.id).not.toBe(ib.id);
    const ordinary = await store.threads.createThread(agent.id, alice.id, "Assistant");
    const rows = await chats.listChats(agent.org_id, alice.id);
    expect(rows.find((row) => row.id === ia.chat_id)?.assistant_inbox).toBe(true);
    expect(rows.find((row) => row.id === ordinary.chat_id)?.assistant_inbox).toBeUndefined();
    expect((await chats.listChats(agent.org_id, alice.id)).map((c) => c.id)).not.toContain(a.chat_id);
    await expect(chats.getChat(agent.org_id, ib.chat_id, alice)).rejects.toThrow();
  });

  it("atomically captures inbox requests with source identity and wakes the same coordinator", async () => {
    const inbox = await ensureCoordinationThread(env!.db, store, agent, bob.id, "inbox");
    await threads.appendEvent(inbox.chat_id, { type: "user_message", attachments: [], content: "Check the project" });
    const before = calls.length;
    await coordination.tick();
    expect(calls.length).toBeGreaterThan(before);
    expect(calls.at(-1)?.kind).toBe("wake");
    expect(String(calls.at(-1)?.content)).toContain(bob.id);
    expect(String(calls.at(-1)?.content)).toContain("bob@example.test");
    expect(String(calls.at(-1)?.content)).toContain(inbox.id);
    const n = calls.length;
    await coordination.tick();
    expect(calls.length).toBe(n);
  });

  it("observes independent thread messages without waking a turn", async () => {
    const thread = await store.threads.createThread(agent.id, alice.id, "Independent");
    await threads.appendEvent(thread.chat_id, { type: "user_message", attachments: [], content: "Independent work" });
    await coordination.tick();
    expect(calls.at(-1)?.kind).toBe("observe");
    expect(JSON.stringify(calls.at(-1)?.content)).toContain("Independent work");
  });

  it("keeps recent unsurfaced tasks in the private display index", async () => {
    const coordinator = await ensureCoordinationThread(env!.db, store, agent, alice.id, "coordinator");
    const tasks: AgentThread[] = [];
    for (let n = 0; n < 23; n++)
      tasks.push(
        await store.threads.createChildThread(coordinator.id, agent.id, alice.id, `Task ${n}`, false, undefined, {
          managed: true,
        }),
      );
    const visible = await store.threads.displayThreads(agent.id, alice.id);
    expect(tasks.every((task) => visible.some((row) => row.id === task.id))).toBe(true);
    expect(
      (await store.threads.displayThreads(agent.id, bob.id)).some((row) => tasks.some((task) => task.id === row.id)),
    ).toBe(false);
  });

  it("excludes archived conversations and hidden routine executions from the display list", async () => {
    const routine = await store.threads.createThread(agent.id, alice.id, "Hidden routine", "routine");
    const archived = await store.threads.createThread(agent.id, alice.id, "Archived conversation");
    await env!.db.query("UPDATE chats SET archived_at=now() WHERE id=$1", [archived.chat_id]);
    const rows = await store.threads.displayThreads(agent.id, alice.id);
    expect(rows.map((row) => row.id)).not.toContain(routine.id);
    expect(rows.map((row) => row.id)).not.toContain(archived.id);
  });

  it("clears reflected payloads and cascades inputs on member removal", async () => {
    const userId = randomUUID();
    await env!.db.query(
      "INSERT INTO users(id,org_id,email,password_hash,role,identity_type) VALUES($1,$2,$3,'','member','managed')",
      [userId, agent.org_id, "departing@example.test"],
    );
    const { rows: [input] } = await env!.db.query<{ id: string }>(
      `INSERT INTO agent_coordination_inputs(agent_id,user_id,content,delivered_at,reflected_at)
       VALUES($1,$2,'expired text',now()-interval '32 days',now()-interval '31 days') RETURNING id`,
      [agent.id, userId],
    );
    await expireReflectedInputContent(env!.db);
    const readInput = () => env!.db.query<{ content: string }>(
      "SELECT content FROM agent_coordination_inputs WHERE id=$1", [input!.id],
    );
    expect((await readInput()).rows).toEqual([{ content: "" }]);
    await env!.db.query("DELETE FROM users WHERE id=$1", [userId]);
    expect((await readInput()).rows).toEqual([]);
  });

  it("keeps the coordinator run summary out of the Activity trace mirror", async () => {
    const coordinator = await ensureCoordinationThread(env!.db, store, agent, alice.id, "coordinator");
    expect(coordinator.type).toBe("user");
    const run = await store.runs.createRun({
      agent_id: agent.id,
      user_id: alice.id,
      thread_id: coordinator.id,
      trigger: "message",
      status: "succeeded",
      summary: "Internal coordination output",
    });
    expect(await runTraceRow(env!.db, run.id)).toBeNull();
  });

  it("runs workspace shell commands without a memory read and detects stale native writes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "guild-memory-"));
    const one = await store.threads.createThread(agent.id, alice.id, "Memory writer");
    const two = await store.threads.createThread(agent.id, bob.id, "Reflection writer");
    await writeFile(path.join(root, "MEMORY.md"), "initial");
    const tools = (threadId: string) =>
      Object.fromEntries(
        ["read", "write", "bash"].map((name) => {
          const tool: ToolRegistration = {
            name,
            description: name,
            replay: "safe",
            parameters: { type: "object" },
            execute: async (args) => {
              const a = args as Record<string, string>;
              if (name === "write") await writeFile(path.join(root, "MEMORY.md"), a["content"]!);
              if (name === "bash" && a["command"] === "update memory")
                await writeFile(path.join(root, "MEMORY.md"), "shell revision");
              return { output: [{ type: "text", text: await readFile(path.join(root, "MEMORY.md"), "utf8") }] };
            },
          };
          return [name, guardMemoryTool(tool, env!.db, root, threadId)];
        }),
      );
    const a = tools(one.id),
      b = tools(two.id);
    const run = (tool: ToolRegistration, args: Record<string, string>) => tool.execute(args, {} as never, {} as never);
    try {
      expect((await run(b["bash"]!, { command: "pwd" })).isError).toBeFalsy();
      await run(a["read"]!, { path: "MEMORY.md" });
      await run(b["read"]!, { path: "./MEMORY.md" });
      await run(a["write"]!, { path: "/workspace/MEMORY.md", content: "newer" });
      expect((await run(b["write"]!, { path: "./MEMORY.md", content: "stale" })).isError).toBe(true);
      expect(await readFile(path.join(root, "MEMORY.md"), "utf8")).toBe("newer");
      expect((await run(b["bash"]!, { command: "update memory" })).isError).toBeFalsy();
      expect((await run(a["write"]!, { path: "MEMORY.md", content: "stale native" })).isError).toBe(true);
      expect(await readFile(path.join(root, "MEMORY.md"), "utf8")).toBe("shell revision");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps multiple independent future wakes distinct and does not deliver them early", async () => {
    const before = calls.length;
    for (const reason of ["Follow up release", "Review proposal"]) {
      await env!.db.query(
        "INSERT INTO agent_coordination_inputs(agent_id,user_id,kind,content,wake,due_at) VALUES($1,$2,'wake',$3,true,now()+interval '1 day')",
        [agent.id, alice.id, reason],
      );
    }
    await coordination.tick();
    expect(calls.length).toBe(before);
    expect(
      (
        await env!.db.query(
          "SELECT 1 FROM agent_coordination_inputs WHERE agent_id=$1 AND kind='wake' AND delivered_at IS NULL",
          [agent.id],
        )
      ).rowCount,
    ).toBe(2);
  });
});

describe("coordination settings", () => {
  it("defaults personal Agents to coordination and personal scope", () => {
    expect(coordinationSettings({ resources: {}, is_personal: true, model: "base" })).toMatchObject({
      enabled: true,
      scope: "member",
      coordinator_model: "base",
    });
  });
  it("supports role-specific models and shared Agent scope", () => {
    expect(
      coordinationSettings({
        resources: { assistant: { enabled: true, reflection_model: "small" } },
        is_personal: false,
        model: "base",
      }),
    ).toMatchObject({ enabled: true, scope: "agent", worker_model: "base", reflection_model: "small" });
  });
});
