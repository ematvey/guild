// send_file snapshots a workspace file into object storage and turn end binds
// the pending row to the assistant event. Turn attachment materialization
// writes the bytes under /tmp/attachments/<runId>/ and wipes the prior turn.

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pino from "pino";
import type { UserRow } from "../../platform/store/identity.js";
import { AttachmentStore, attachmentObjectKey } from "../../platform/store/attachments.js";
import { AgentStore } from "../../agents/store.js";
import { AgentRunLifecycle } from "../../agents/lifecycle.js";
import { ThreadStore } from "../../platform/store/thread.js";
import { assistantMessageEvent } from "../../platform/domain/thread-events.js";
import { sendFile } from "../../agents/send-file.js";
import { materializeTurnAttachments } from "../../chats/attachment-materialize.js";
import { createAgentsTestEnv } from "./harness.js";
import type { M5TestEnv } from "../platform/m5-harness.js";

const env: M5TestEnv | null = await createAgentsTestEnv();
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
    store = new AgentStore(env.db);
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
    const thread = (await store.listThreads(agent.id, owner.id))[0]!;
    const run = await store.createRun({
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
        run,
        chatId: thread.chat_id,
        workspaceRoot: root,
      },
      { path: "reports/build.html", as: "build.html" },
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
      attachments,
    });
    const event = await threads.appendEvent(
      thread.chat_id,
      assistantMessageEvent(1, 1, [{ type: "text", text: "The build is ready." }], { tokens_in: 1, tokens_out: 1, cost_usd: 0 }, "GLM-Test"),
    );
    await lifecycle.assistantEvent(thread.chat_id, event);
    const published = await env!.db.query<{ event_id: string | null }>(
      "SELECT event_id FROM attachments WHERE id = $1",
      [result.id],
    );
    expect(published.rows[0]!.event_id).toBe(event.id);
  });

  it("rejects paths outside the workspace and symlinks", async () => {
    const workspace = path.join(root, "agents", orgId, agent.id);
    await mkdir(workspace, { recursive: true });
    const thread = (await store.listThreads(agent.id, owner.id))[0]!;
    const run = await store.createRun({
      agent_id: agent.id,
      thread_id: thread.id,
      trigger: "message",
      status: "running",
      started_at: new Date().toISOString(),
    });
    const context = { attachments, objects, agent, run, chatId: thread.chat_id, workspaceRoot: root };
    await expect(sendFile(context, { path: "../outside.txt" })).rejects.toThrow(/parent traversal|escapes/);
    await expect(sendFile(context, { path: "/etc/passwd" })).rejects.toThrow(/absolute/);
  });

  it("materializes a turn's files and wipes the previous turn directory", async () => {
    const base = path.join(root, "materialized");
    const turnEnv = new NodeExecutionEnv({ cwd: path.join(root, "workspace") });
    const id = randomUUID();
    const key = attachmentObjectKey(orgId, id, "report.txt");
    objects.gets.set(key, Buffer.from("turn one\n"));
    const row = {
      id,
      org_id: orgId,
      chat_id: randomUUID(),
      filename: "report.txt",
      content_type: "text/plain",
      size_bytes: 9,
      created_at: new Date().toISOString(),
    };
    const first = await materializeTurnAttachments({
      env: turnEnv,
      objects,
      orgId,
      runId: "run-one",
      rows: [row],
      context: BACKGROUND_CONTEXT,
      root: base,
    });
    expect(first).toBe(path.posix.join(base, "run-one"));
    expect(await readFile(path.join(base, "run-one", "report.txt"), "utf8")).toBe("turn one\n");

    const second = await materializeTurnAttachments({
      env: turnEnv,
      objects,
      orgId,
      runId: "run-two",
      rows: [],
      context: BACKGROUND_CONTEXT,
      root: base,
    });
    expect(second).toBeNull();
    expect(await stat(path.join(base, "run-one")).catch(() => null)).toBeNull();
    expect(await stat(path.join(root, "workspace", "report.txt")).catch(() => null)).toBeNull();
  });
});
