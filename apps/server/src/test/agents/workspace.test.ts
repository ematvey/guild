// Workspace resolution: Agent threads mount the Agent Workspace and use
// their sandbox scope; plain chats keep a per-conversation target.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "../../platform/store/identity.js";
import { ChatStore } from "../../platform/store/chats.js";
import { AgentStore } from "../../agents/store.js";
import { agentThreadForChat, resolveConversationWorkspace } from "../../agents/workspace.js";
import { createAgentsTestEnv } from "./harness.js";
import type { HubTestEnv } from "../support/hub-env.js";

const env: HubTestEnv | null = await createAgentsTestEnv();
const dbDescribe = env === null ? describe.skip : describe;

dbDescribe("agent workspace resolution", () => {
  let store: AgentStore;
  let chats: ChatStore;
  let owner: UserRow;
  let orgId: string;

  beforeAll(async () => {
    if (env === null) return;
    store = new AgentStore({ pool: env.db, chats: new ChatStore(env.db) });
    chats = new ChatStore(env.db);
    orgId = randomUUID();
    await env.db.query("INSERT INTO orgs (id, name) VALUES ($1, 'agents-workspace-org')", [orgId]);
    const id = randomUUID();
    const res = await env.db.query(
      `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
       VALUES ($1, $2, 'agents-workspace@example.test', '', 'member', 'managed')
       RETURNING id, org_id, email, role, identity_type`,
      [id, orgId],
    );
    owner = {
      ...(res.rows[0] as Omit<UserRow, "display_name" | "avatar_url" | "onboarded_at">),
      display_name: null,
      avatar_url: null,
      onboarded_at: null,
    };
  }, 60_000);

  afterAll(async () => {
    await env?.cleanup();
  });

  it("keeps the personal Agent on its unpartitioned sandbox", async () => {
    const agent = await store.create(owner, { name: "Workspace", model: "GLM-Test" });
    await env!.db.query("UPDATE agents SET is_personal = true WHERE id = $1", [agent.id]);
    const thread = await store.threads.createThread(agent.id, owner.id, "Personal");
    expect(await agentThreadForChat(env!.db, thread.chat_id)).toEqual({
      thread_id: thread.id,
      agent_id: agent.id,
      org_id: orgId,
      user_id: owner.id,
      is_personal: true,
      internal: false,
    });
    const target = await resolveConversationWorkspace(env!.db, {
      conversationId: 41,
      orgId,
      chatId: thread.chat_id,
      agentWorkspaceRoot: "/srv/agents",
      plainHostRoot: "/tmp/plain",
    });
    expect(target).toMatchObject({
      key: `agent:${orgId}:${agent.id}`,
      subpath: `agents/${orgId}/${agent.id}`,
      hostDir: path.resolve("/srv/agents", `agents/${orgId}/${agent.id}`),
      agentId: agent.id,
    });
  });

  it("shares one Workspace while separating each Member and the internal Threads", async () => {
    const agent = await store.create(owner, { name: "Shared Workspace", model: "GLM-Test", visibility: "org" });
    const memberId = randomUUID();
    await env!.db.query(
      `INSERT INTO users (id, org_id, email, password_hash, role, identity_type)
       VALUES ($1, $2, 'member@example.test', '', 'member', 'managed')`,
      [memberId, orgId],
    );
    const threads = await Promise.all([
      store.threads.createThread(agent.id, owner.id, "Owner"),
      store.threads.createThread(agent.id, owner.id, "Another owner Thread"),
      store.threads.createThread(agent.id, memberId, "Member"),
      store.threads.createThread(agent.id, owner.id, "Coordinator", "user", {
        executionRole: "coordinator",
        internal: true,
      }),
      store.threads.createThread(agent.id, owner.id, "Reflection", "user", {
        executionRole: "reflection",
        internal: true,
      }),
    ]);
    const targets = await Promise.all(
      threads.map((thread, index) =>
        resolveConversationWorkspace(env!.db, {
          conversationId: 100 + index,
          orgId,
          chatId: thread.chat_id,
          agentWorkspaceRoot: "/srv/agents",
          plainHostRoot: "/tmp/plain",
        }),
      ),
    );
    const prefix = `agent:${orgId}:${agent.id}`;
    expect(targets.map((target) => target.key)).toEqual([
      `${prefix}:member:${owner.id}`,
      `${prefix}:member:${owner.id}`,
      `${prefix}:member:${memberId}`,
      `${prefix}:background`,
      `${prefix}:background`,
    ]);
    expect(new Set(targets.map((target) => target.subpath))).toEqual(new Set([`agents/${orgId}/${agent.id}`]));
    expect(new Set(targets.map((target) => target.hostDir))).toEqual(
      new Set([path.resolve("/srv/agents", `agents/${orgId}/${agent.id}`)]),
    );
  });

  it("keeps a plain chat on its per-conversation target", async () => {
    const chat = await chats.createChat(orgId, owner.id, "plain chat", null);
    expect(await agentThreadForChat(env!.db, chat.id)).toBeNull();
    const target = await resolveConversationWorkspace(env!.db, {
      conversationId: 42,
      orgId,
      chatId: chat.id,
      agentWorkspaceRoot: "/srv/agents",
      plainHostRoot: "/tmp/plain",
    });
    expect(target).toEqual({
      key: `chat:${orgId}:42`,
      subpath: `chats/${orgId}/42`,
      hostDir: "/tmp/plain/42",
      chatId: chat.id,
      agentId: null,
    });
  });
});
