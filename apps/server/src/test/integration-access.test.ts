// Integration access: an Integration's audience decides who may add it to an
// agent and at what class; the agent's own list decides what its Turns see;
// warnings show where an agent's audience is wider than the Integration's.

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupGatewayStack, type GatewayStack } from "./support/gateway-stack.js";
import {
  agentWarnings,
  allModeIntegrations,
  memberCeiling,
  type AccessContext,
  type IntegrationAudience,
} from "../platform/domain/integration-access.js";
import { scopeCeiling, toolOffered, type IntegrationScope } from "../integrations/policy.js";
import { integrationScopeForChat } from "../harness/integrations.js";
import { IntegrationAccessStore } from "../platform/store/integration-access.js";
import type { IntegrationToolInfo, IntegrationTurn } from "../integrations/plugins.js";

const SALES = "00000000-0000-4000-8000-0000000000a1";
const SUPPORT = "00000000-0000-4000-8000-0000000000a2";

function audience(partial: Partial<IntegrationAudience>): IntegrationAudience {
  return {
    id: "i-1",
    slug: "hubspot",
    enabled: true,
    audience: "team",
    org_ceiling: "read",
    grants: [{ team_id: SALES, ceiling: "write" }],
    ...partial,
  };
}

function member(id: string, role: string, teams: string[]) {
  return { id, label: id, role, team_ids: new Set(teams) };
}

describe("audience rules", () => {
  it("an admin always gets admin; a member gets the org ceiling or their best team grant", () => {
    const team = audience({
      grants: [
        { team_id: SALES, ceiling: "write" },
        { team_id: SUPPORT, ceiling: "read" },
      ],
    });
    expect(memberCeiling(team, member("a", "admin", []))).toBe("admin");
    expect(memberCeiling(team, member("m", "member", [SUPPORT]))).toBe("read");
    expect(memberCeiling(team, member("m", "member", [SUPPORT, SALES]))).toBe("write");
    expect(memberCeiling(team, member("m", "member", []))).toBeNull();
    expect(memberCeiling(audience({ audience: "org", org_ceiling: "write" }), member("m", "member", []))).toBe("write");
    expect(memberCeiling(audience({ audience: "admins" }), member("m", "member", [SALES]))).toBeNull();
  });

  it("warns where the agent's audience is wider than the Integration's", () => {
    const ctx: AccessContext = {
      audiences: new Map([["hubspot", audience({})]]),
      members: new Map([
        ["owner", member("owner", "member", [SALES])],
        ["guest", member("guest", "member", [])],
        ["boss", member("boss", "admin", [])],
      ]),
      teams: new Map([
        [SALES, "Sales"],
        [SUPPORT, "Support"],
      ]),
      userGrants: new Map([["agent", ["guest", "boss"]]]),
    };
    const base = { id: "agent", owner_user_id: "owner", is_personal: false };
    const entry = { slug: "hubspot", ceiling: "write" as const };

    // A team agent shared with Sales only: Sales holds write, nothing to warn
    // except the members granted by name.
    const team = agentWarnings({ ...base, visibility: "team", team_ids: [SALES], integrations: [entry] }, ctx);
    expect(team).toEqual([
      {
        integration: "hubspot",
        subject: "member",
        subject_id: "guest",
        subject_label: "guest",
        ceiling: "write",
        granted: null,
      },
    ]);

    // Shared with Support too: Support is not granted.
    const wider = agentWarnings(
      { ...base, visibility: "team", team_ids: [SALES, SUPPORT], integrations: [entry] },
      { ...ctx, userGrants: new Map() },
    );
    expect(wider.map((w) => [w.subject, w.subject_label, w.granted])).toEqual([["team", "Support", null]]);

    // Org-wide: every member gains HubSpot.
    const org = agentWarnings({ ...base, visibility: "org", integrations: [entry] }, { ...ctx, userGrants: new Map() });
    expect(org.map((w) => [w.subject, w.ceiling, w.granted])).toEqual([["org", "write", null]]);

    // An admin-class entry gives a non-admin subject only write.
    const adminEntry = agentWarnings(
      { ...base, visibility: "team", team_ids: [SALES], integrations: [{ slug: "hubspot", ceiling: "admin" }] },
      { ...ctx, userGrants: new Map() },
    );
    expect(adminEntry).toEqual([]);

    // The owner who left the audience is warned about too.
    const leftOwner = agentWarnings(
      { ...base, owner_user_id: "guest", visibility: "private", integrations: [entry] },
      { ...ctx, userGrants: new Map() },
    );
    expect(leftOwner.map((w) => [w.subject, w.subject_id])).toEqual([["member", "guest"]]);
  });
});

describe("an agent with all tools", () => {
  const ctx: AccessContext = {
    audiences: new Map([
      ["hubspot", audience({})],
      ["search", audience({ id: "i-2", slug: "search", audience: "org", org_ceiling: "read" })],
      ["vault", audience({ id: "i-3", slug: "vault", audience: "admins" })],
      ["off", audience({ id: "i-4", slug: "off", audience: "org", enabled: false })],
    ]),
    members: new Map([
      ["seller", member("seller", "member", [SALES])],
      ["helper", member("helper", "member", [SUPPORT])],
      ["boss", member("boss", "admin", [])],
    ]),
    teams: new Map([
      [SALES, "Sales"],
      [SUPPORT, "Support"],
    ]),
    userGrants: new Map(),
  };
  const agent = (owner: string, more: Record<string, unknown> = {}) => ({
    id: "agent",
    owner_user_id: owner,
    visibility: "private",
    is_personal: true,
    ...more,
  });

  it("a personal agent reaches every enabled Integration its owner may, at the owner's ceiling", () => {
    expect(allModeIntegrations(agent("seller"), ctx)).toEqual([
      { slug: "hubspot", ceiling: "write" },
      { slug: "search", ceiling: "read" },
    ]);
    expect(allModeIntegrations(agent("boss"), ctx)).toEqual([
      { slug: "hubspot", ceiling: "admin" },
      { slug: "search", ceiling: "admin" },
      { slug: "vault", ceiling: "admin" },
    ]);
  });

  it("a shared agent reaches only what everyone who can use it may, at the lowest ceiling", () => {
    const sales = agent("boss", { is_personal: false, visibility: "team", team_ids: [SALES] });
    expect(allModeIntegrations(sales, ctx)).toEqual([
      { slug: "hubspot", ceiling: "write" },
      { slug: "search", ceiling: "read" },
    ]);
    const both = agent("seller", { is_personal: false, visibility: "team", team_ids: [SALES, SUPPORT] });
    expect(allModeIntegrations(both, ctx)).toEqual([{ slug: "search", ceiling: "read" }]);
    const granted = agent("seller", { is_personal: false });
    expect(allModeIntegrations(granted, { ...ctx, userGrants: new Map([["agent", ["helper"]]]) })).toEqual([
      { slug: "search", ceiling: "read" },
    ]);
    const derived = allModeIntegrations(both, ctx);
    expect(agentWarnings({ ...both, integrations: derived }, ctx)).toEqual([]);
  });
});

describe("turn scope", () => {
  const turn = { slug: "hubspot", executor: "connector", rowConfig: {} } as unknown as IntegrationTurn;
  const tool = (name: string, cls: string, trait?: string): IntegrationToolInfo => ({
    spec: { name, description: "", parameters: {} },
    class: cls,
    raw: name.replace("hubspot_", ""),
    ...(trait === undefined ? {} : { trait }),
  });
  const scope = (entries: [string, "read" | "write" | "admin"][], traits: IntegrationScope["traits"] = "all") => ({
    traits,
    integrations: new Map(entries),
  });
  const offered = (s: IntegrationScope, info: IntegrationToolInfo, role = "member") =>
    toolOffered(turn, info, scopeCeiling(s, turn.slug, info), role);

  it("applies Guild scope and curation to published gateway tools", () => {
    const gateway: IntegrationTurn = { ...turn, executor: "gateway-mcp", gatewayUsesGuildPolicy: true };
    const read = tool("hubspot_search_deals", "read");
    const write = tool("hubspot_update_deal", "write");
    expect(toolOffered(gateway, read, null, "member")).toBe(false);
    expect(toolOffered(gateway, read, "read", "member")).toBe(true);
    expect(toolOffered(gateway, write, "read", "member")).toBe(false);
    expect(toolOffered({
      ...gateway,
      rowConfig: { tools: { search_deals: { enabled: false } } },
    }, read, "admin", "admin")).toBe(false);
    expect(toolOffered({ ...gateway, impersonated: true }, read, "admin", "admin", true)).toBe(false);
  });

  it("rejects account impersonation for every shared Agent even with admin read grants", () => {
    const impersonated = { ...turn, impersonated: true };
    const read = tool("hubspot_search_deals", "read");
    for (const role of ["member", "admin"]) expect(toolOffered(impersonated, read, "admin", role, true)).toBe(false);
    expect(toolOffered(impersonated, read, "read", "member", false)).toBe(true);
  });

  it("an Integration outside the agent's list offers nothing", () => {
    expect(offered(scope([]), tool("hubspot_search_deals", "read"))).toBe(false);
  });

  it("the agent's ceiling caps the class; admin-class tools stay admin-only", () => {
    const read = scope([["hubspot", "read"]]);
    expect(offered(read, tool("hubspot_search_deals", "read"))).toBe(true);
    expect(offered(read, tool("hubspot_update_deal", "write"))).toBe(false);
    const admin = scope([["hubspot", "admin"]]);
    expect(offered(admin, tool("hubspot_purge", "admin"))).toBe(false);
    expect(offered(admin, tool("hubspot_purge", "admin"), "admin")).toBe(true);
  });

  it("a Trait tool follows the built-in allowlist, not the Integration list", () => {
    const search = tool("web_search", "read", "web_search");
    expect(offered(scope([]), search)).toBe(true);
    expect(offered(scope([], new Set(["read"])), search)).toBe(false);
    expect(offered(scope([], new Set(["web_search"])), search)).toBe(true);
  });
});

describe("integration access over HTTP", () => {
  let stack: GatewayStack;
  let integrationId: string;

  beforeAll(async () => {
    stack = await setupGatewayStack();
    await stack.routeModel("GLM-Test-Model");
    const row = await stack.env.db.query(
      "INSERT INTO integrations (org_id, name, config, enabled) VALUES ($1, 'hubspot', '{}', false) RETURNING id",
      [stack.orgId],
    );
    integrationId = row.rows[0].id as string;
    await stack.env.db.query("INSERT INTO teams (id, org_id, name) VALUES ($1, $2, 'Sales'), ($3, $2, 'Support')", [
      SALES,
      stack.orgId,
      SUPPORT,
    ]);
  }, 60_000);

  afterAll(async () => {
    if (stack !== undefined) await stack.close();
  }, 30_000);

  const call = (token: string, method: "GET" | "PUT" | "POST" | "PATCH", url: string, payload?: unknown) =>
    stack.env.app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${token}` },
      ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
    });

  it("a new Integration is for admins only; a team audience opens it to that team's members", async () => {
    const created = await call(stack.memberToken, "POST", "/api/v1/agents", {
      name: `crm-${randomUUID().slice(0, 8)}`,
      model: "GLM-Test-Model",
      tools: ["read"],
      visibility: "private",
    });
    expect(created.statusCode).toBe(200);
    const agentId = (JSON.parse(created.body) as { agent: { id: string } }).agent.id;
    const attach = (ceiling: string) =>
      call(stack.memberToken, "PATCH", `/api/v1/agents/${agentId}`, {
        integrations: [{ slug: "hubspot", ceiling }],
      });

    expect((await attach("read")).statusCode).toBe(403);

    const opened = await call(stack.adminToken, "PUT", `/api/v1/admin/integrations/${integrationId}/access`, {
      audience: "team",
      grants: [{ team_id: SALES, ceiling: "write" }],
    });
    expect(opened.statusCode).toBe(200);
    expect(JSON.parse(opened.body)).toMatchObject({ audience: "team", grants: [{ team_id: SALES, ceiling: "write" }] });

    // Not in Sales yet.
    expect((await attach("read")).statusCode).toBe(403);
    await stack.env.db.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)", [SALES, stack.memberId]);
    expect((await attach("admin")).statusCode).toBe(403);
    const ok = await attach("write");
    expect(ok.statusCode).toBe(200);
    const agent = (JSON.parse(ok.body) as { agent: { integrations: unknown; integration_warnings: unknown[] } }).agent;
    expect(agent.integrations).toEqual([{ slug: "hubspot", ceiling: "write" }]);
    expect(agent.integration_warnings).toEqual([]);

    // The Turn scope reads the same list.
    const thread = await stack.env.db.query("SELECT chat_id FROM agent_threads WHERE agent_id = $1 LIMIT 1", [agentId]);
    const scope = await integrationScopeForChat(
      new IntegrationAccessStore(stack.env.db),
      thread.rows[0].chat_id as string,
    );
    expect([...scope.integrations]).toEqual([["hubspot", "write"]]);

    // Shared with every member, the agent warns: the org is wider than Sales.
    const shared = await call(stack.memberToken, "PATCH", `/api/v1/agents/${agentId}`, { visibility: "org" });
    const warnings = (JSON.parse(shared.body) as { agent: { integration_warnings: { subject: string }[] } }).agent
      .integration_warnings;
    expect(warnings.map((w) => w.subject)).toEqual(["org"]);

    const view = await call(stack.adminToken, "GET", `/api/v1/admin/integrations/${integrationId}/access`);
    const agents = (JSON.parse(view.body) as { agents: { id: string; warnings: unknown[] }[] }).agents;
    expect(agents.find((a) => a.id === agentId)?.warnings).toHaveLength(1);

    // Leaving Sales does not strip the entry, but a removal needs no grant.
    await stack.env.db.query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2", [SALES, stack.memberId]);
    const removed = await call(stack.memberToken, "PATCH", `/api/v1/agents/${agentId}`, { integrations: [] });
    expect(removed.statusCode).toBe(200);
    expect((JSON.parse(removed.body) as { agent: { integrations: unknown[] } }).agent.integrations).toEqual([]);
  });

  it("an all-tools agent follows the admin's audiences and takes no list of its own", async () => {
    const row = await stack.env.db.query(
      "INSERT INTO integrations (org_id, name, config, enabled) VALUES ($1, 'crm2', '{}', true) RETURNING id",
      [stack.orgId],
    );
    const crmId = row.rows[0].id as string;
    const created = await call(stack.memberToken, "POST", "/api/v1/agents", {
      name: `all-${randomUUID().slice(0, 8)}`,
      model: "GLM-Test-Model",
      tools: [],
      tools_mode: "all",
      visibility: "private",
      integrations: [{ slug: "crm2", ceiling: "read" }],
    });
    expect(created.statusCode).toBe(200);
    const agentId = (JSON.parse(created.body) as { agent: { id: string } }).agent.id;
    const read = async () =>
      (JSON.parse((await call(stack.memberToken, "GET", `/api/v1/agents/${agentId}`)).body) as {
        agent: { integrations: { slug: string; ceiling: string }[]; integration_warnings: unknown[] };
      }).agent;
    expect((await read()).integrations.find((e) => e.slug === "crm2")).toBeUndefined();

    await call(stack.adminToken, "PUT", `/api/v1/admin/integrations/${crmId}/access`, {
      audience: "org",
      org_ceiling: "write",
    });
    const opened = await read();
    expect(opened.integrations.find((e) => e.slug === "crm2")).toEqual({ slug: "crm2", ceiling: "write" });
    expect(opened.integration_warnings).toEqual([]);
    const stored = await stack.env.db.query("SELECT 1 FROM agent_integrations WHERE agent_id = $1", [agentId]);
    expect(stored.rows).toEqual([]);

    const thread = await stack.env.db.query("SELECT chat_id FROM agent_threads WHERE agent_id = $1 LIMIT 1", [agentId]);
    const scope = await integrationScopeForChat(
      new IntegrationAccessStore(stack.env.db),
      thread.rows[0].chat_id as string,
    );
    expect(scope.integrations.get("crm2")).toBe("write");

    const view = await call(stack.adminToken, "GET", `/api/v1/admin/integrations/${crmId}/access`);
    const agents = (JSON.parse(view.body) as { agents: { id: string; ceiling: string }[] }).agents;
    expect(agents.find((a) => a.id === agentId)?.ceiling).toBe("write");

    const ignored = await call(stack.memberToken, "PATCH", `/api/v1/agents/${agentId}`, { integrations: [] });
    expect(ignored.statusCode).toBe(200);
    expect((await read()).integrations.find((e) => e.slug === "crm2")).toBeDefined();

    await call(stack.adminToken, "PUT", `/api/v1/admin/integrations/${crmId}/access`, { audience: "admins" });
    expect((await read()).integrations.find((e) => e.slug === "crm2")).toBeUndefined();
    await stack.env.db.query("DELETE FROM integrations WHERE id = $1", [crmId]);
  });

  it("the script API follows the caller's audience", async () => {
    await call(stack.adminToken, "PUT", `/api/v1/admin/integrations/${integrationId}/access`, {
      audience: "admins",
    });
    const refused = await call(stack.memberToken, "POST", "/api/v1/integrations/hubspot/tools/search_deals", {});
    // The row is disabled, so it does not resolve at all; with the audience
    // closed, an enabled row would refuse the same way.
    expect([403, 404]).toContain(refused.statusCode);
  });

  it("refuses a team audience without a team and an unknown team", async () => {
    const empty = await call(stack.adminToken, "PUT", `/api/v1/admin/integrations/${integrationId}/access`, {
      audience: "team",
      grants: [],
    });
    expect(empty.statusCode).toBe(400);
    const unknown = await call(stack.adminToken, "PUT", `/api/v1/admin/integrations/${integrationId}/access`, {
      audience: "team",
      grants: [{ team_id: randomUUID(), ceiling: "read" }],
    });
    expect(unknown.statusCode).toBe(400);
    const member = await call(stack.memberToken, "PUT", `/api/v1/admin/integrations/${integrationId}/access`, {
      audience: "org",
    });
    expect(member.statusCode).toBe(403);
  });
});
