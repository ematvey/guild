// send_file snapshots a workspace file into object storage and turn end binds
// the pending row to the assistant event. Turn attachment materialization
// writes the bytes under /tmp/attachments/<runId>/, prunes finished Run
// directories, and adds the files of inputs placed later in the turn. A parent can fetch the
// files its child results carry.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import type { UserRow } from "../../platform/store/identity.js";
import { AttachmentStore, attachmentObjectKey } from "../../platform/store/attachments.js";
import { AgentStore } from "../../agents/store.js";
import { ChatStore } from "../../platform/store/chats.js";
import { AgentRunLifecycle } from "../../agents/lifecycle.js";
import { ThreadStore } from "../../platform/store/thread.js";
import { assistantMessageEvent } from "../../platform/domain/thread-events.js";
import { sendFile } from "../../agents/send-file.js";
import { materializeTurnAttachments, pruneTurnAttachments } from "../../chats/attachment-materialize.js";
import { createAgentsTestEnv } from "./harness.js";
import type { HubTestEnv } from "../support/hub-env.js";

const env: HubTestEnv | null = await createAgentsTestEnv();
const dbDescribe = env === null ? describe.skip : describe;

class FakeObjects {
  readonly puts = new Map<string, Buffer>();
  readonly gets = new Map<string, Buffer>();

  async put(key: string, bytes: Buffer): Promise<void> {
    this.puts.set(key, bytes);
    this.gets.set(key, bytes);
  }

  async get(key: string): Promise<Buffer> {
    const bytes = this.gets.get(key);
    if (bytes === undefined) throw new Error(`no such object: ${key}`);
    return bytes;
  }
}

async function makeUser(orgId: string, email: string): Promise<UserRow> {
  const res = await env!.db.query(
    `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
     VALUES ($1, $2, $3, '', 'member', 'managed')
     RETURNING id, org_id, email, role, identity_type`,
    [randomUUID(), orgId, email],
  );
  return {
    ...(res.rows[0] as Omit<UserRow, "display_name" | "avatar_url" | "onboarded_at">),
    display_name: null,
    avatar_url: null,
    onboarded_at: null,
  };
}

dbDescribe("agent send_file and turn attachments", () => {
  let store: AgentStore;
  let threads: ThreadStore;
  let attachments: AttachmentStore;
  let objects: FakeObjects;
  let owner: UserRow;
  let orgId: string;
  let agent: Awaited<ReturnType<AgentStore["create"]>>;
  let root: string;

  beforeAll(async () => {
    if (env === null) return;
    store = new AgentStore({ pool: env.db, chats: new ChatStore(env.db) });
    threads = new ThreadStore(env.db);
    attachments = new AttachmentStore(env.db);
    objects = new FakeObjects();
    orgId = randomUUID();
    await env.db.query("INSERT INTO orgs (id, name) VALUES ($1, 'agents-send-file-org')", [orgId]);
    owner = await makeUser(orgId, "send-file@example.test");
    agent = await store.create(owner, { name: "Sender", model: "GLM-Test" });
    root = await mkdtemp(path.join(tmpdir(), "guild-send-file-"));
  }, 60_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    await env?.cleanup();
  });

  it("uploads, records a pending agent attachment and publishes it at turn end", async () => {
    const thread = (await store.threads.listThreads(agent.id, owner.id)).threads[0]!;
    await store.runs.createRun({
      agent_id: agent.id,
      thread_id: thread.id,
      trigger: "message",
      status: "running",
      started_at: new Date().toISOString(),
    });
    const workspace = path.join(root, "agents", orgId, agent.id);
    await mkdir(path.join(workspace, "reports"), { recursive: true });
    await writeFile(path.join(workspace, "reports", "build.html"), "<h1>done</h1>");

    const result = await sendFile(
      {
        attachments,
        objects,
        agent,
        chatId: thread.chat_id,
        machineEnv: () => Promise.reject(new Error("no machine in this test")),
      },
      { path: "reports/build.html", as: "build.html" },
      new NodeExecutionEnv({ cwd: workspace }),
      BACKGROUND_CONTEXT,
    );
    expect(result).toMatchObject({
      filename: "build.html",
      content_type: "text/html",
      size_bytes: 13,
      source_path: "reports/build.html",
    });
    expect(result.sha256).toHaveLength(64);
    expect(objects.puts.get(attachmentObjectKey(orgId, result.id, "build.html"))?.toString()).toBe("<h1>done</h1>");

    const row = await attachments.get(orgId, result.id);
    expect(row.filename).toBe("build.html");
    expect((await attachments.pendingAgentFiles(thread.chat_id)).map((r) => r.id)).toEqual([result.id]);
    const raw = await env!.db.query<{
      event_id: string | null;
      author_kind: string;
      author_id: string;
      source_path: string;
    }>("SELECT event_id, author_kind, author_id, source_path FROM attachments WHERE id = $1", [result.id]);
    expect(raw.rows[0]).toEqual({
      event_id: null,
      author_kind: "agent",
      author_id: agent.id,
      source_path: "reports/build.html",
    });

    const lifecycle = new AgentRunLifecycle({
      pool: env!.db,
      log: pino({ level: "silent" }),
      runs: store.runs,
      attachments,
    });
    const event = await threads.appendEvent(
      thread.chat_id,
      assistantMessageEvent(
        1,
        1,
        [{ type: "text", text: "The build is ready." }],
        { tokens_in: 1, tokens_out: 1, cost_usd: 0 },
        "GLM-Test",
      ),
    );
    await lifecycle.runEnd(thread.chat_id, [], null);
    const published = await env!.db.query<{ event_id: string | null }>(
      "SELECT event_id FROM attachments WHERE id = $1",
      [result.id],
    );
    expect(published.rows[0]!.event_id).toBe(event.id);
    expect(await attachments.pendingAgentFiles(thread.chat_id)).toEqual([]);
  });

  it("refuses a path that leaves the working folder", async () => {
    const workspace = path.join(root, "agents", orgId, agent.id);
    await mkdir(workspace, { recursive: true });
    const thread = (await store.threads.listThreads(agent.id, owner.id)).threads[0]!;
    const context = {
      attachments,
      objects,
      agent,
      chatId: thread.chat_id,
      machineEnv: () => Promise.reject(new Error("no machine in this test")),
    };
    const callEnv = new NodeExecutionEnv({ cwd: workspace });
    await expect(sendFile(context, { path: "../outside.txt" }, callEnv, BACKGROUND_CONTEXT)).rejects.toThrow(
      /leave the working folder/,
    );
    await expect(sendFile(context, { path: "/etc/passwd" }, callEnv, BACKGROUND_CONTEXT)).rejects.toThrow(
      /relative to the working folder/,
    );
  });

  it("keeps parallel Run caches and reclaims a finished Run after executor restart", async () => {
    const base = path.join(root, "materialized");
    const sandbox = new NodeExecutionEnv({ cwd: path.join(root, "workspace") });
    const running = async (title: string) => {
      const thread = await store.threads.createThread(agent.id, owner.id, title);
      return store.runs.createRun({
        agent_id: agent.id,
        thread_id: thread.id,
        trigger: "message",
        status: "running",
      });
    };
    const first = await running("First attachment Run");
    const second = await running("Parallel attachment Run");
    const row = (filename: string, content: string) => {
      const id = randomUUID();
      objects.gets.set(attachmentObjectKey(orgId, id, filename), Buffer.from(content));
      return {
        id,
        org_id: orgId,
        chat_id: randomUUID(),
        filename,
        content_type: "text/plain",
        size_bytes: content.length,
        created_at: new Date().toISOString(),
      };
    };
    const write = (runId: string, rows: ReturnType<typeof row>[]) =>
      materializeTurnAttachments({
        env: sandbox,
        objects,
        orgId,
        runId,
        rows,
        context: BACKGROUND_CONTEXT,
        root: base,
      });
    await write(first.id, [row("report.txt", "first Run")]);
    expect(await write(second.id, [])).toBeNull();
    await write(second.id, [row("report.txt", "second Run")]);

    const firstFile = path.join(base, first.id, "report.txt");
    const secondFile = path.join(base, second.id, "report.txt");
    const restartedSandbox = new NodeExecutionEnv({ cwd: sandbox.cwd });
    const prune = () =>
      pruneTurnAttachments(
        restartedSandbox,
        BACKGROUND_CONTEXT,
        (ids, staleIds) => store.runs.removableAttachmentRunIds(ids, staleIds),
        base,
      );
    await prune();
    expect(await readFile(firstFile, "utf8")).toBe("first Run");
    expect(await readFile(secondFile, "utf8")).toBe("second Run");

    await store.runs.updateRun(first.id, { status: "succeeded", finished_at: new Date().toISOString() });
    await prune();
    await expect(stat(firstFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(secondFile, "utf8")).toBe("second Run");
    await expect(stat(path.join(sandbox.cwd, "report.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("resumes a bounded sweep after a full page with no removable directories", async () => {
    const base = path.join(root, "prune-pages");
    const sandbox = new NodeExecutionEnv({ cwd: root });
    await mkdir(base);
    for (let index = 0; index < 67; index++) {
      await mkdir(path.join(base, randomUUID()));
    }

    // Choose candidates from the second filesystem page without assuming
    // the filesystem orders its entries by name or creation time.
    const opened = await sandbox.openDirReader(base, BACKGROUND_CONTEXT);
    if (!opened.ok) throw opened.error;
    const reader = opened.value;
    const first = await reader.next(64, BACKGROUND_CONTEXT);
    const tail = await reader.next(64, BACKGROUND_CONTEXT);
    await reader.close(BACKGROUND_CONTEXT);
    if (!first.ok) throw first.error;
    if (!tail.ok) throw tail.error;
    expect(first.value.entries).toHaveLength(64);
    expect(tail.value.entries).toHaveLength(3);
    const [orphan, changed, fresh] = tail.value.entries;
    const old = new Date(Date.now() - 10 * 60_000);
    const orphanDir = path.join(base, orphan!.name);
    const changedDir = path.join(base, changed!.name);
    await utimes(orphanDir, old, old);
    await utimes(changedDir, old, old);

    const checked: { ids: string[]; staleIds: string[] }[] = [];
    const prune = () =>
      pruneTurnAttachments(
        sandbox,
        BACKGROUND_CONTEXT,
        async (ids, staleIds) => {
          checked.push({ ids, staleIds });
          const removable = await store.runs.removableAttachmentRunIds(ids, staleIds);
          // A cache changed after the durable lookup must survive.
          if (removable.includes(changed!.name)) await utimes(changedDir, new Date(), new Date());
          return removable;
        },
        base,
      );
    await Promise.all([prune(), prune()]);
    expect(checked).toHaveLength(1);
    expect(checked[0]?.ids).toHaveLength(64);
    expect(checked[0]?.staleIds).toEqual([]);
    expect((await stat(orphanDir)).isDirectory()).toBe(true);
    await prune();
    expect(checked).toHaveLength(2);
    expect(checked[1]?.ids).toHaveLength(3);
    expect(checked[1]?.staleIds).toEqual([orphan!.name, changed!.name]);
    await expect(stat(orphanDir)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await stat(changedDir)).isDirectory()).toBe(true);
    expect((await stat(path.join(base, fresh!.name))).isDirectory()).toBe(true);
  });

  it("lists the files of every input a run took, including ones placed mid-run", async () => {
    const thread = await store.threads.createThread(agent.id, owner.id, "Inputs", "user");
    const chatId = thread.chat_id;
    const file = (name: string) => ({
      id: randomUUID(),
      filename: name,
      content_type: "text/plain",
      size_bytes: 1,
      modality: "document" as const,
    });
    const old = file("old.txt");
    const first = file("first.txt");
    const steered = file("steered.txt");
    const fromChild = file("child.txt");
    await threads.appendEvent(chatId, { type: "user_message", content: "earlier", attachments: [old] });
    await threads.appendEvent(
      chatId,
      assistantMessageEvent(
        1,
        1,
        [{ type: "text", text: "done" }],
        { tokens_in: 1, tokens_out: 1, cost_usd: 0 },
        "GLM-Test",
      ),
    );
    await threads.appendEvent(chatId, { type: "user_message", content: "now", attachments: [first] });
    const startedAt = new Date(Date.now() + 5).toISOString();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await threads.appendEvent(
      chatId,
      assistantMessageEvent(
        2,
        1,
        [{ type: "tool_call", id: "call-1", name: "bash", arguments: "{}" }],
        { tokens_in: 1, tokens_out: 1, cost_usd: 0 },
        "GLM-Test",
      ),
    );
    expect(await threads.turnAttachmentIds(chatId, startedAt)).toEqual([first.id]);
    await threads.appendEvent(chatId, { type: "user_message", content: "also this", attachments: [steered] });
    await threads.appendEvent(chatId, {
      type: "child_result",
      thread_id: randomUUID(),
      run_id: randomUUID(),
      chat_id: randomUUID(),
      agent_name: "Child",
      title: "task",
      status: "succeeded",
      final_text: "attached",
      attachments: [fromChild],
    });
    expect(await threads.turnAttachmentIds(chatId, startedAt)).toEqual([first.id, steered.id, fromChild.id]);
  });

  it("adds a mid-run input's files without wiping the turn's directory", async () => {
    const base = path.join(root, "added");
    const turnEnv = new NodeExecutionEnv({ cwd: path.join(root, "workspace") });
    const row = (name: string, content: string) => {
      const id = randomUUID();
      objects.gets.set(attachmentObjectKey(orgId, id, name), Buffer.from(content));
      return {
        id,
        org_id: orgId,
        chat_id: randomUUID(),
        filename: name,
        content_type: "text/plain",
        size_bytes: content.length,
        created_at: new Date().toISOString(),
      };
    };
    const args = { env: turnEnv, objects, orgId, runId: "run-a", context: BACKGROUND_CONTEXT, root: base };
    await materializeTurnAttachments({ ...args, rows: [row("first.txt", "one")] });
    await materializeTurnAttachments({ ...args, rows: [row("later.txt", "two")] });
    expect(await readFile(path.join(base, "run-a", "first.txt"), "utf8")).toBe("one");
    expect(await readFile(path.join(base, "run-a", "later.txt"), "utf8")).toBe("two");
  });

  it("lets a parent reach the files its child results carry, and no others", async () => {
    const parent = await store.threads.createThread(agent.id, owner.id, "Parent", "user");
    const other = await store.threads.createThread(agent.id, owner.id, "Other", "user");
    const shared = await attachments.create(
      randomUUID(),
      orgId,
      other.chat_id,
      owner.id,
      "result.csv",
      "text/csv",
      3,
      "key-result",
    );
    const unrelated = await attachments.create(
      randomUUID(),
      orgId,
      other.chat_id,
      owner.id,
      "private.txt",
      "text/plain",
      3,
      "key-private",
    );
    expect((await attachments.reachableFromChat(orgId, parent.chat_id)).map((row) => row.id)).toEqual([]);
    await threads.appendEvent(parent.chat_id, {
      type: "child_result",
      thread_id: other.id,
      run_id: randomUUID(),
      chat_id: other.chat_id,
      agent_name: "Child",
      title: "task",
      status: "succeeded",
      final_text: "see file",
      attachments: [
        { id: shared.id, filename: "result.csv", content_type: "text/csv", size_bytes: 3, modality: "document" },
      ],
    });
    const reachable = (await attachments.reachableFromChat(orgId, parent.chat_id)).map((row) => row.id);
    expect(reachable).toEqual([shared.id]);
    expect(reachable).not.toContain(unrelated.id);
  });
});
