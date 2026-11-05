// The guild introspection tools: the admin's personal assistant reads the
// org's members, usage, threads and agents. The gate is the owner's admin
// role plus the agent's personal flag; the reads are the org scope of
// 002-access, so a member's thread is listed and read whole.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupGatewayStack, type GatewayStack } from "../support/gateway-stack.js";
import { createStores, type PlatformStores } from "../../platform/stores.js";
import { clickhouseFromConfig } from "../../platform/clickhouse.js";
import { UsageReports } from "../../platform/store/usage.js";
import { AgentStore } from "../../agents/store.js";
import { createGuildTools, guildToolsAllowed } from "../../agents/guild-tools.js";
import type { UserRow } from "../../platform/store/identity.js";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { compile } from "@earendil-works/pi-schema";

let stack: GatewayStack;
let stores: PlatformStores;
let agents: AgentStore;
let admin: UserRow;
let member: UserRow;
let memberChatId: string;

beforeAll(async () => {
  stack = await setupGatewayStack();
  stores = createStores(stack.env.db);
  agents = new AgentStore({ pool: stack.env.db, chats: stores.chats });
  admin = await stores.identity.getUser(stack.adminId);
  member = await stores.identity.getUser(stack.memberId);
  const chat = await stores.chats.createChat(member.org_id, member.id, "member thread", null);
  memberChatId = chat.id;
  await stack.env.db.query(
    "INSERT INTO thread_events (id, chat_id, type, payload) VALUES ($1,$2,'user_message',$3)",
    [randomUUID(), chat.id, JSON.stringify({ type: "user_message", content: "how do I use guild", attachments: [] })],
  );
}, 60_000);

afterAll(async () => {
  if (stack !== undefined) await stack.close();
}, 30_000);

function tools(owner: UserRow): ToolRegistration[] {
  const usage = new UsageReports(clickhouseFromConfig(stack.env.config));
  return createGuildTools({
    pool: stack.env.db,
    identity: stores.identity,
    teams: stores.teams,
    agents,
    chats: stores.chats,
    usage,
    admin: owner,
  });
}

function tool(list: ToolRegistration[], name: string): ToolRegistration {
  const found = list.find((entry) => entry.name === name);
  if (found === undefined) throw new Error(`missing tool ${name}`);
  return found;
}

async function call(list: ToolRegistration[], name: string, args: object = {}): Promise<Record<string, unknown>> {
  const result = (await tool(list, name).execute(args as never, {} as never, {} as never)) as {
    structuredOutput?: Record<string, unknown>;
    output?: { text?: string }[];
    isError?: boolean;
  };
  if (result.isError === true) throw new Error(result.output?.[0]?.text ?? "tool failed");
  const out = result.structuredOutput ?? {};
  // The bridge's own validator: a schema the harness refuses fails here.
  const validator = compile(tool(list, name).structuredOutputSchema as never, { unresolvedRefs: "reject" });
  expect(validator.check(out)).toBe(true);
  return out;
}

describe("the guild tools", () => {
  it("belong to the admin's personal assistant only", () => {
    expect(guildToolsAllowed({ is_personal: true }, "admin")).toBe(true);
    expect(guildToolsAllowed({ is_personal: true }, "member")).toBe(false);
    expect(guildToolsAllowed({ is_personal: false }, "admin")).toBe(false);
  });

  it("are the six org reads, each declaring its structured output", () => {
    const list = tools(admin);
    expect(list.map((entry) => entry.name)).toEqual([
      "guild_overview",
      "guild_members",
      "guild_usage",
      "guild_threads",
      "guild_thread_read",
      "guild_agents",
    ]);
    for (const entry of list) expect(entry.structuredOutputSchema).toBeDefined();
  });

  it("lists every member with their role", async () => {
    const out = await call(tools(admin), "guild_members");
    const members = out["members"] as { email: string; role: string }[];
    expect(members.map((row) => row.role).sort()).toEqual(["admin", "member"]);
  });

  it("lists a member's thread, which the sidebar list never shows an admin", async () => {
    const own = await stores.chats.listChats(member.org_id, admin.id);
    expect(own.map((row) => row.id)).not.toContain(memberChatId);
    const out = await call(tools(admin), "guild_threads");
    const threads = out["threads"] as { thread_id: string; email: string }[];
    const listed = threads.find((row) => row.thread_id === memberChatId);
    expect(listed?.email).toBe(member.email);
  });

  it("reads a member's transcript", async () => {
    const out = await call(tools(admin), "guild_thread_read", { thread_id: memberChatId });
    const events = out["events"] as { text: string }[];
    expect(events.some((event) => event.text.includes("how do I use guild"))).toBe(true);
  });

  it("counts the org in the overview", async () => {
    const out = await call(tools(admin), "guild_overview");
    expect((out["members"] as { total: number }).total).toBe(2);
    expect((out["threads"] as { total: number }).total).toBeGreaterThan(0);
  });

  it("lists every agent of the org", async () => {
    const created = await agents.create(member, { name: `guild-tools-${randomUUID().slice(0, 8)}`, model: "GLM-Test" });
    const out = await call(tools(admin), "guild_agents");
    const rows = out["agents"] as { agent_id: string; owner_email: string }[];
    expect(rows.find((row) => row.agent_id === created.id)?.owner_email).toBe(member.email);
  });
});
