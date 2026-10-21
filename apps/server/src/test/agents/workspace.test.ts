// Workspace resolution: an agent thread maps every turn to the agent's
// shared workspace/sandbox; a plain chat keeps its per-conversation target.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { UserRow } from "../../platform/store/identity.js";
import { ChatStore } from "../../platform/store/chats.js";
import { AgentStore } from "../../agents/store.js";
import { agentThreadForChat, resolveConversationWorkspace } from "../../agents/workspace.js";
import { createAgentsTestEnv } from "./harness.js";
import type { M5TestEnv } from "../platform/m5-harness.js";

const env: M5TestEnv | null = await createAgentsTestEnv();
const dbDescribe = env === null ? describe.skip : describe;

dbDescribe("agent workspace resolution", () => {
  let store: AgentStore;
  let chats: ChatStore;
  let owner: UserRow;
  let orgId: string;

  beforeAll(async () => {
    if (env === null) return;
    store = new AgentStore(env.db);
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

  it("routes an agent thread to the shared agent workspace", async () => {
    const agent = await store.create(owner, { name: "Workspace", model: "GLM-Test" });
    const thread = (await store.listThreads(agent.id, owner.id))[0]!;
    expect(await agentThreadForChat(env!.db, thread.chat_id)).toEqual({
      agent_id: agent.id,
      org_id: orgId,
      user_id: owner.id,
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
