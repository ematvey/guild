// AgentStore: creation (default thread + chat), visibility and grant roles,
// lifecycle transitions, thread index and run/activity/inbox rows.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "../../platform/store/identity.js";
import { AgentStore, deriveTitleFromMessage } from "../../agents/store.js";
import { createAgentsTestEnv } from "./harness.js";
import type { M5TestEnv } from "../platform/m5-harness.js";

const env: M5TestEnv | null = await createAgentsTestEnv();
const dbDescribe = env === null ? describe.skip : describe;

dbDescribe("AgentStore", () => {
  let store: AgentStore;
  let orgId: string;
  let owner: UserRow;
  let member: UserRow;
  let admin: UserRow;
  let teamId: string;

  async function makeUser(email: string, role: "admin" | "member"): Promise<UserRow> {
    const id = randomUUID();
    const res = await env!.db.query(
      `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
       VALUES ($1, $2, $3, '', $4, 'managed') RETURNING id, org_id, email, role, identity_type`,
      [id, orgId, email, role],
    );
    return {
      ...(res.rows[0] as Omit<UserRow, "display_name" | "avatar_url" | "onboarded_at">),
      display_name: null,
      avatar_url: null,
      onboarded_at: null,
    };
  }

  beforeAll(async () => {
    if (env === null) return;
    store = new AgentStore(env.db);
    orgId = randomUUID();
    await env.db.query("INSERT INTO orgs (id, name) VALUES ($1, $2)", [orgId, "agents-store-org"]);
    owner = await makeUser("agents-owner@example.test", "member");
    member = await makeUser("agents-member@example.test", "member");
    admin = await makeUser("agents-admin@example.test", "admin");
    teamId = randomUUID();
    await env.db.query("INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'agents-team')", [teamId, orgId]);
    await env.db.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)", [teamId, member.id]);
  }, 60_000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("creates the agent, its default thread and the thread's chat", async () => {
    const agent = await store.create(owner, { name: "Writer", model: "GLM-Test" });
    expect(agent.owner_user_id).toBe(owner.id);
    expect(agent.visibility).toBe("private");
    expect(agent.status).toBe("active");
    expect(agent.tools).toContain("send_message");

    const threads = await store.listThreads(agent.id, owner.id);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.kind).toBe("default");
    expect(threads[0]!.title).toBe("Main thread");
    const chat = await env!.db.query("SELECT user_id, title FROM chats WHERE id = $1", [threads[0]!.chat_id]);
    expect(chat.rows[0]!.user_id).toBe(owner.id);
    expect(chat.rows[0]!.title).toBe("Main thread");
  });

  it("derives a short, word-bounded title from the first line", () => {
    expect(deriveTitleFromMessage("  # Plan the launch  ")).toBe("Plan the launch");
    expect(
      deriveTitleFromMessage(
        "Create memories/hello.md with a short note about yourself, then list the workspace and tell me what you wrote.",
      ),
    ).toBe("Create memories/hello.md with a short note about yourself…");
    expect(deriveTitleFromMessage("oneverylongwordwithoutspaces".repeat(3))).toHaveLength(60);
  });

  it("filters private agents by owner and explicit grants", async () => {
    const agent = await store.create(owner, { name: "Private", model: "GLM-Test" });
    await expect(store.get(member, agent.id)).rejects.toMatchObject({ status: 404 });
    expect((await store.list(member)).map((a) => a.id)).not.toContain(agent.id);

    await env!.db.query("INSERT INTO agent_grants (agent_id, user_id, role) VALUES ($1, $2, 'viewer')", [
      agent.id,
      member.id,
    ]);
    const visible = await store.get(member, agent.id);
    const access = await store.access(member, visible);
    expect(access).toMatchObject({ role: "viewer", can_use: true, can_manage: false });
  });

  it("resolves org visibility, team grants and admin override", async () => {
    const orgAgent = await store.create(owner, { name: "Org", model: "GLM-Test", visibility: "org" });
    const orgAccess = await store.access(member, await store.get(member, orgAgent.id));
    expect(orgAccess).toMatchObject({ role: null, can_use: true, can_manage: false });
    await expect(store.update(member, orgAgent.id, { name: "Nope" })).rejects.toMatchObject({ status: 403 });

    const teamAgent = await store.create(owner, { name: "Team", model: "GLM-Test", visibility: "team" });
    await expect(store.get(member, teamAgent.id)).rejects.toMatchObject({ status: 404 });
    await env!.db.query(
      "INSERT INTO agent_team_grants (agent_id, team_id, role) VALUES ($1, $2, 'editor')",
      [teamAgent.id, teamId],
    );
    const teamAccess = await store.access(member, await store.get(member, teamAgent.id));
    expect(teamAccess).toMatchObject({ role: "editor", can_use: true, can_manage: false });

    const adminAccess = await store.access(admin, await store.get(admin, orgAgent.id));
    expect(adminAccess).toMatchObject({ role: "owner", can_manage: true });
    const renamed = await store.update(admin, orgAgent.id, { name: "Org renamed" });
    expect(renamed.name).toBe("Org renamed");
  });

  it("updates config, archives, restores and marks deletion with the grace window", async () => {
    const agent = await store.create(owner, { name: "Lifecycle", model: "GLM-Test" });
    const updated = await store.update(owner, agent.id, {
      tools: ["read", "conversations_search"],
      visibility: "org",
    });
    expect(updated.tools).toEqual(["read", "conversations_search"]);
    expect(updated.visibility).toBe("org");

    const archived = await store.archive(owner, agent.id);
    expect(archived.status).toBe("archived");
    expect((await store.list(owner)).map((a) => a.id)).not.toContain(agent.id);
    expect((await store.list(owner, { includeArchived: true })).map((a) => a.id)).toContain(agent.id);

    expect((await store.restore(owner, agent.id)).status).toBe("active");

    const deleting = await store.markDeleted(owner, agent.id);
    expect(deleting.status).toBe("deleting");
    expect(deleting.deleted_at).not.toBeNull();
    const purgeAfter = Date.parse(deleting.purge_after!);
    const days = (purgeAfter - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);

    await expect(store.purge(member, agent.id)).rejects.toMatchObject({ status: 403 });
    const threads = await store.listThreads(agent.id, owner.id);
    await store.purge(owner, agent.id);
    await expect(store.fetchAgent(agent.id)).rejects.toMatchObject({ status: 404 });
    const leftover = await env!.db.query("SELECT id FROM chats WHERE id = $1", [threads[0]!.chat_id]);
    expect(leftover.rowCount).toBe(0);
  });

  it("creates, lists, renames and touches threads", async () => {
    const agent = await store.create(owner, { name: "Threads", model: "GLM-Test" });
    const extra = await store.createThread(agent.id, owner.id, "Second conversation");
    expect(extra.kind).toBe("thread");
    expect(extra.title).toBe("Second conversation");
    expect(extra.chat_id).toBeTruthy();

    const threads = await store.listThreads(agent.id, owner.id);
    expect(threads[0]!.kind).toBe("default");

    const renamed = await store.renameThread(agent.id, owner.id, extra.id, "Renamed");
    expect(renamed.title).toBe("Renamed");
    expect(renamed.title_locked).toBe(true);
    const chat = await env!.db.query("SELECT title FROM chats WHERE id = $1", [extra.chat_id]);
    expect(chat.rows[0]!.title).toBe("Renamed");

    const before = renamed.last_activity_at;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.touchThread(agent.id, extra.id);
    expect((await store.getThread(agent.id, owner.id, extra.id)).last_activity_at >= before).toBe(true);
  });

  it("keeps each user's threads private inside a shared agent", async () => {
    const agent = await store.create(owner, { name: "Shared", model: "GLM-Test", visibility: "org" });
    const mine = await store.createThread(agent.id, owner.id, "Owner thread");
    const theirs = await store.createThread(agent.id, member.id, "Member thread");

    expect((await store.listThreads(agent.id, owner.id)).map((t) => t.id)).not.toContain(theirs.id);
    expect((await store.listThreads(agent.id, member.id)).map((t) => t.id)).not.toContain(mine.id);
    await expect(store.getThread(agent.id, member.id, mine.id)).rejects.toMatchObject({ status: 404 });
    await expect(store.renameThread(agent.id, member.id, mine.id, "Hijack")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("gives every user of a shared agent their own default thread", async () => {
    const agent = await store.create(owner, { name: "Defaults", model: "GLM-Test", visibility: "org" });
    const ownerDefault = await store.ensureDefaultThread(agent.id, owner.id);
    const memberDefault = await store.ensureDefaultThread(agent.id, member.id);
    expect(ownerDefault.id).not.toBe(memberDefault.id);
    expect(ownerDefault.user_id).toBe(owner.id);
    expect(memberDefault.user_id).toBe(member.id);
    // Idempotent: the second call returns the same row.
    expect((await store.ensureDefaultThread(agent.id, member.id)).id).toBe(memberDefault.id);
  });

  it("creates one personal agent per user and refuses to archive or delete it", async () => {
    await env!.db.query(
      "INSERT INTO model_routes (org_id, model, provider, enabled, price_per_mtok_in_usd, price_per_mtok_out_usd) VALUES ($1, 'personal-model', 'guild', true, 0, 0)",
      [orgId],
    );
    const personal = await store.ensurePersonalAgent(owner);
    expect(personal).not.toBeNull();
    expect(personal!.name).toBe("Assistant");
    expect(personal!.is_personal).toBe(true);
    expect(personal!.visibility).toBe("private");
    // The personal agent follows every tool the org enables.
    expect(personal!.tools_mode).toBe("all");
    expect(personal!.model).toBe("personal-model");
    // Idempotent.
    expect((await store.ensurePersonalAgent(owner))!.id).toBe(personal!.id);
    // One per user.
    const memberPersonal = await store.ensurePersonalAgent(member);
    expect(memberPersonal!.id).not.toBe(personal!.id);

    // Another user — even an admin — cannot see or use a personal agent.
    await expect(store.get(admin, personal!.id)).rejects.toMatchObject({ status: 404 });
    expect((await store.list(admin)).map((a) => a.id)).not.toContain(personal!.id);

    await expect(store.archive(owner, personal!.id)).rejects.toMatchObject({ status: 400 });
    await expect(store.markDeleted(owner, personal!.id)).rejects.toMatchObject({ status: 400 });
    await expect(store.update(owner, personal!.id, { visibility: "org" })).rejects.toMatchObject({
      status: 400,
    });
  });

  it("does not cap the number of agents in an organization", async () => {
    const created = [];
    for (let i = 0; i < 30; i += 1) {
      created.push(await store.create(owner, { name: `Bulk ${i}`, model: "GLM-Test" }));
    }
    expect(created).toHaveLength(30);
  });

  it("records runs, activity, notices and chunk search rows", async () => {
    const agent = await store.create(owner, { name: "Runs", model: "GLM-Test" });
    const thread = (await store.listThreads(agent.id, owner.id))[0]!;
    const run = await store.createRun({ agent_id: agent.id, thread_id: thread.id, trigger: "message" });
    expect(run.status).toBe("queued");
    const finished = await store.updateRun(run.id, {
      status: "succeeded",
      summary: "done",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      tokens: 12,
    });
    expect(finished.status).toBe("succeeded");
    expect(finished.summary).toBe("done");
    expect((await store.getRun(run.id)).tokens).toBe(12);
    expect((await store.listRuns(agent.id, { status: "succeeded" })).map((r) => r.id)).toEqual([run.id]);

    const activity = await store.listActivity(orgId, { agent_id: agent.id }, owner);
    expect(activity).toHaveLength(1);
    expect(activity[0]!.agent_name).toBe("Runs");
    const hidden = await store.listActivity(orgId, { agent_id: agent.id }, member);
    expect(hidden).toHaveLength(0);

    const notice = await store.createNotice({
      org_id: orgId,
      agent_id: agent.id,
      user_id: owner.id,
      kind: "routine_failed",
      payload: { message: "boom" },
    });
    expect(notice.read_at).toBeNull();
    expect(await store.listNotices(owner.id, orgId)).toHaveLength(1);
    expect((await store.markNoticeRead(owner.id, notice.id)).read_at).not.toBeNull();
    await expect(store.markNoticeRead(member.id, notice.id)).rejects.toMatchObject({ status: 404 });

    await store.insertChunks([
      {
        thread_id: thread.id,
        agent_id: agent.id,
        seq_from: 1,
        seq_to: 2,
        text: "User: how do I bake bread?\n\nAssistant: mix flour and water.",
      },
    ]);
    const hits = await store.searchThreads(agent.id, "bread");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.thread_id).toBe(thread.id);
  });
});
