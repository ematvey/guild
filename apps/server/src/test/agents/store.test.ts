// AgentStore: creation (default thread + chat), visibility and grant roles,
// lifecycle transitions, thread index and run/activity/inbox rows.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "../../platform/store/identity.js";
import { AgentStore, deriveTitleFromMessage } from "../../agents/store.js";
import { ChatStore } from "../../platform/store/chats.js";
import { insertChunks, search } from "../../agents/search.js";
import { createAgentsTestEnv } from "./harness.js";
import type { HubTestEnv } from "../support/hub-env.js";

const env: HubTestEnv | null = await createAgentsTestEnv();
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
    store = new AgentStore({ pool: env.db, chats: new ChatStore(env.db) });
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
    expect(agent.description).toBe("");
    expect(agent.tools).toContain("send_message");

    const threads = (await store.threads.listThreads(agent.id, owner.id)).threads;
    expect(threads).toHaveLength(1);
    expect(threads[0]!.type).toBe("user");
    expect(threads[0]!.is_default).toBe(true);
    expect(threads[0]!.title).toBe("Main thread");
    const chat = await env!.db.query("SELECT user_id, title FROM chats WHERE id = $1", [threads[0]!.chat_id]);
    expect(chat.rows[0]!.user_id).toBe(owner.id);
    expect(chat.rows[0]!.title).toBe("Main thread");
  });

  it("stores a description on create and update", async () => {
    const agent = await store.create(owner, {
      name: "Described",
      model: "GLM-Test",
      description: "Writes launch notes.",
    });
    expect(agent.description).toBe("Writes launch notes.");
    expect((await store.fetchAgent(agent.id)).description).toBe("Writes launch notes.");

    const updated = await store.update(owner, agent.id, { description: "Reviews launch notes." });
    expect(updated.description).toBe("Reviews launch notes.");
    const cleared = await store.update(owner, agent.id, { description: "" });
    expect(cleared.description).toBe("");
  });

  it("derives a short, word-bounded title from the first line", () => {
    expect(deriveTitleFromMessage("  # Plan the launch  ")).toBe("Plan the launch");
    expect(
      deriveTitleFromMessage(
        "Create memories/hello.md with a short note about yourself, then list the workspace and tell me what you wrote.",
      ),
    ).toBe("Create memories/hello.md with a short note…");
    expect(deriveTitleFromMessage("oneverylongwordwithoutspaces".repeat(3))).toHaveLength(60);
  });

  it("filters private agents by owner and explicit grants", async () => {
    const agent = await store.create(owner, { name: "Private", model: "GLM-Test" });
    await expect(store.get(member, agent.id)).rejects.toMatchObject({ status: 404 });
    expect((await store.list(member)).map((a) => a.id)).not.toContain(agent.id);

    // A role other than `user` grants nothing: a viewer row neither shows
    // the agent nor lets the member use it.
    await env!.db.query("INSERT INTO agent_grants (agent_id, user_id, role) VALUES ($1, $2, 'viewer')", [
      agent.id,
      member.id,
    ]);
    await expect(store.get(member, agent.id)).rejects.toMatchObject({ status: 404 });
    expect(await store.access(member, agent)).toMatchObject({ role: null, can_use: false, can_manage: false });

    await env!.db.query("UPDATE agent_grants SET role = 'user' WHERE agent_id = $1 AND user_id = $2", [
      agent.id,
      member.id,
    ]);
    const visible = await store.get(member, agent.id);
    const access = await store.access(member, visible);
    expect(access).toMatchObject({ role: "user", can_use: true, can_manage: false });
  });

  it("lets an admin read every agent of the org, personal ones included", async () => {
    const personal = await store.create(member, { name: "Member Assistant", model: "GLM-Test" });
    await env!.db.query("UPDATE agents SET is_personal = true WHERE id = $1", [personal.id]);
    await expect(store.get(owner, personal.id)).rejects.toMatchObject({ status: 404 });
    expect((await store.list(admin)).map((a) => a.id)).toContain(personal.id);
    expect((await store.get(admin, personal.id)).id).toBe(personal.id);
  });

  it("resolves org visibility, team grants and admin override", async () => {
    const orgAgent = await store.create(owner, { name: "Org", model: "GLM-Test", visibility: "org" });
    const orgAccess = await store.access(member, await store.get(member, orgAgent.id));
    expect(orgAccess).toMatchObject({ role: null, can_use: true, can_manage: false });
    await expect(store.update(member, orgAgent.id, { name: "Nope" })).rejects.toMatchObject({ status: 403 });

    const teamAgent = await store.create(owner, { name: "Team", model: "GLM-Test", visibility: "team" });
    await expect(store.get(member, teamAgent.id)).rejects.toMatchObject({ status: 404 });
    await env!.db.query("INSERT INTO agent_team_grants (agent_id, team_id, role) VALUES ($1, $2, 'editor')", [
      teamAgent.id,
      teamId,
    ]);
    await expect(store.get(member, teamAgent.id)).rejects.toMatchObject({ status: 404 });
    await env!.db.query("UPDATE agent_team_grants SET role = 'user' WHERE agent_id = $1", [teamAgent.id]);
    const teamAccess = await store.access(member, await store.get(member, teamAgent.id));
    expect(teamAccess).toMatchObject({ role: "user", can_use: true, can_manage: false });

    const adminAccess = await store.access(admin, await store.get(admin, orgAgent.id));
    expect(adminAccess).toMatchObject({ role: "owner", can_manage: true });
    const renamed = await store.update(admin, orgAgent.id, { name: "Org renamed" });
    expect(renamed.name).toBe("Org renamed");
  });

  it("an update whose team grants fail leaves the agent row unchanged", async () => {
    const agent = await store.create(owner, { name: "Atomic", model: "GLM-Test", visibility: "team" });
    await expect(
      store.update(owner, agent.id, { name: "Atomic renamed", team_ids: [teamId, randomUUID()] }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await store.get(owner, agent.id)).name).toBe("Atomic");
  });

  it("updates config, archives, restores and marks deletion with the grace window", async () => {
    const agent = await store.create(owner, { name: "Lifecycle", model: "GLM-Test" });
    const updated = await store.update(owner, agent.id, {
      tools: ["read", "conversations_search"],
      visibility: "org",
    });
    expect(updated.tools).toEqual(["read", "conversations_search"]);
    expect(updated.visibility).toBe("org");

    const archived = await store.lifecycle.archive(owner, agent.id);
    expect(archived.status).toBe("archived");
    expect((await store.list(owner)).map((a) => a.id)).not.toContain(agent.id);
    expect((await store.list(owner, { includeArchived: true })).map((a) => a.id)).toContain(agent.id);

    expect((await store.lifecycle.restore(owner, agent.id)).status).toBe("active");
    await expect(store.lifecycle.restore(owner, agent.id)).rejects.toMatchObject({ status: 400 });

    const deleting = await store.lifecycle.markDeleted(owner, agent.id);
    expect(deleting.status).toBe("deleting");
    expect(deleting.deleted_at).not.toBeNull();
    const purgeAfter = Date.parse(deleting.purge_after!);
    const days = (purgeAfter - Date.now()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29);
    expect(days).toBeLessThan(31);

    await expect(store.lifecycle.purge(member, agent.id)).rejects.toMatchObject({ status: 403 });
    const threads = (await store.threads.listThreads(agent.id, owner.id)).threads;
    await store.lifecycle.purge(owner, agent.id);
    await expect(store.fetchAgent(agent.id)).rejects.toMatchObject({ status: 404 });
    const leftover = await env!.db.query("SELECT id FROM chats WHERE id = $1", [threads[0]!.chat_id]);
    expect(leftover.rowCount).toBe(0);
  });

  it("creates, lists, renames and touches threads", async () => {
    const agent = await store.create(owner, { name: "Threads", model: "GLM-Test" });
    const extra = await store.threads.createThread(agent.id, owner.id, "Second conversation");
    expect(extra.type).toBe("user");
    expect(extra.is_default).toBe(false);
    expect(extra.title).toBe("Second conversation");
    expect(extra.chat_id).toBeTruthy();

    const threads = (await store.threads.listThreads(agent.id, owner.id)).threads;
    expect(threads.some((thread) => thread.is_default)).toBe(true);

    const renamed = await store.threads.renameThread(agent.id, owner.id, extra.id, "Renamed");
    expect(renamed.title).toBe("Renamed");
    expect(renamed.title_locked).toBe(true);
    const chat = await env!.db.query("SELECT title FROM chats WHERE id = $1", [extra.chat_id]);
    expect(chat.rows[0]!.title).toBe("Renamed");

    // Age the stamp so the touch moves it whatever the clock's resolution.
    await env!.db.query(
      "UPDATE agent_threads SET last_activity_at = last_activity_at - interval '1 minute' WHERE id = $1",
      [extra.id],
    );
    const before = (await store.threads.getThread(agent.id, owner.id, extra.id)).last_activity_at;
    await store.threads.touchThread(agent.id, extra.id);
    expect((await store.threads.getThread(agent.id, owner.id, extra.id)).last_activity_at > before).toBe(true);
  });

  it("keeps each user's threads private inside a shared agent", async () => {
    const agent = await store.create(owner, { name: "Shared", model: "GLM-Test", visibility: "org" });
    const mine = await store.threads.createThread(agent.id, owner.id, "Owner thread");
    const theirs = await store.threads.createThread(agent.id, member.id, "Member thread");

    expect((await store.threads.listThreads(agent.id, owner.id)).threads.map((t) => t.id)).not.toContain(theirs.id);
    expect((await store.threads.listThreads(agent.id, member.id)).threads.map((t) => t.id)).not.toContain(mine.id);
    await expect(store.threads.getThread(agent.id, member.id, mine.id)).rejects.toMatchObject({ status: 404 });
    await expect(store.threads.renameThread(agent.id, member.id, mine.id, "Hijack")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("keeps the Main thread its creator's alone", async () => {
    const agent = await store.create(owner, { name: "Defaults", model: "GLM-Test", visibility: "org" });
    expect(await store.threads.mainThread(agent.id, owner.id)).not.toBeNull();
    expect(await store.threads.mainThread(agent.id, member.id)).toBeNull();
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

    // Another member cannot see a personal agent; an admin reads every
    // agent of the org, personal ones included.
    await expect(store.get(member, personal!.id)).rejects.toMatchObject({ status: 404 });
    expect((await store.list(admin)).map((a) => a.id)).toContain(personal!.id);

    await expect(store.lifecycle.archive(owner, personal!.id)).rejects.toMatchObject({ status: 400 });
    await expect(store.lifecycle.markDeleted(owner, personal!.id)).rejects.toMatchObject({ status: 400 });
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

  it("cancelAgentRuns stops every live run of the agent and names their chats", async () => {
    const agent = await store.create(owner, { name: "Leaving", model: "GLM-Test" });
    const main = (await store.threads.listThreads(agent.id, owner.id)).threads[0]!;
    const side = await store.threads.createThread(agent.id, owner.id, "Side");
    const live = await store.runs.createRun({
      agent_id: agent.id,
      thread_id: main.id,
      trigger: "message",
      status: "running",
    });
    const queued = await store.runs.createRun({ agent_id: agent.id, thread_id: side.id, trigger: "message" });
    const done = await store.runs.createRun({
      agent_id: agent.id,
      thread_id: side.id,
      trigger: "message",
      status: "succeeded",
    });
    const chats = await store.lifecycle.cancelAgentRuns(agent.id);
    expect(chats.sort()).toEqual([main.chat_id, side.chat_id].sort());
    expect((await store.runs.getRun(live.id)).status).toBe("cancelled");
    expect((await store.runs.getRun(queued.id)).status).toBe("cancelled");
    expect((await store.runs.getRun(done.id)).status).toBe("succeeded");
    expect(await store.lifecycle.cancelAgentRuns(agent.id)).toEqual([]);
  });

  it("records runs, activity, notices and chunk search rows", async () => {
    const agent = await store.create(owner, { name: "Runs", model: "GLM-Test" });
    const thread = (await store.threads.listThreads(agent.id, owner.id)).threads[0]!;
    const run = await store.runs.createRun({ agent_id: agent.id, thread_id: thread.id, trigger: "message" });
    expect(run.status).toBe("queued");
    const finished = await store.runs.updateRun(run.id, {
      status: "succeeded",
      summary: "done",
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      tokens: 12,
    });
    expect(finished.status).toBe("succeeded");
    expect(finished.summary).toBe("done");
    expect((await store.runs.getRun(run.id)).tokens).toBe(12);
    expect((await store.runs.listRuns(agent.id, { status: "succeeded" })).map((r) => r.id)).toEqual([run.id]);

    const activity = await store.runs.listActivity(orgId, { agent_id: agent.id }, owner);
    expect(activity).toHaveLength(1);
    expect(activity[0]!.agent_name).toBe("Runs");
    const hidden = await store.runs.listActivity(orgId, { agent_id: agent.id }, member);
    expect(hidden).toHaveLength(0);

    const notice = await store.notices.createNotice({
      org_id: orgId,
      agent_id: agent.id,
      user_id: owner.id,
      kind: "routine_failed",
      payload: { message: "boom" },
    });
    expect(notice.read_at).toBeNull();
    expect(await store.notices.listNotices(owner.id, orgId)).toHaveLength(1);
    expect((await store.notices.markNoticeRead(owner.id, notice.id)).read_at).not.toBeNull();
    await expect(store.notices.markNoticeRead(member.id, notice.id)).rejects.toMatchObject({ status: 404 });

    await insertChunks(env!.db, [
      {
        thread_id: thread.id,
        agent_id: agent.id,
        seq_from: 1,
        seq_to: 2,
        text: "User: how do I bake bread?\n\nAssistant: mix flour and water.",
      },
    ]);
    const hits = await search(env!.db, { agentId: agent.id, userId: owner.id, query: "bread" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.thread_id).toBe(thread.id);
  });
});
