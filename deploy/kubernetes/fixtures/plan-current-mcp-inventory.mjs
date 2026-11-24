import assert from "node:assert/strict";
import { PlatformContext } from "./src/composition.ts";
import { loadConfig } from "./src/config.ts";
import { IntegrationAccessStore } from "./src/platform/store/integration-access.ts";
import { callerScope } from "./src/integrations/member-tools.ts";
import { resolveIntegrations } from "./src/integrations/plugins.ts";
import { scopeCeiling, toolOffered } from "./src/integrations/policy.ts";
import sharedVendors from "./src/integrations/shared-mcp-vendors.json" with { type: "json" };

const org = process.env.PROBE_ORG_ID;
assert.match(org ?? "", /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const ctx = new PlatformContext(loadConfig());
try {
  const { rows: [{ count }] } = await ctx.pool.query(
    "SELECT count(*)::int AS count FROM user_mcp_servers WHERE org_id=$1 AND enabled", [org],
  );
  assert.equal(count, 0, "add personal connections to the publication plan explicitly");
  const access = new IntegrationAccessStore(ctx.pool);
  const [members, rows] = await Promise.all([ctx.identity.listUsers(org), ctx.integrations.listEnabled(org)]);
  assert.ok(members.length, "organization has no members");
  const warnings = [];
  const turns = await resolveIntegrations(ctx, org, (warning) => warnings.push(warning));
  assert.equal(warnings.length, 0, "direct discovery reported errors; resolve them before planning");
  const scopes = await Promise.all(members.map(async (member) => ({
    member, scope: await callerScope(access, { org, userId: member.id, email: member.email, role: member.role }),
  })));
  const targets = [];
  for (const row of rows) {
    const turn = turns.find((candidate) => candidate.slug === row.name);
    assert.ok(turn, `direct discovery omitted ${row.name}`);
    const memberTools = Object.fromEntries(scopes.flatMap(({ member, scope }) => {
      const allowed = turn.tools.filter((tool) =>
        toolOffered(turn, tool, scopeCeiling(scope, turn.slug, tool), member.role)).map((tool) => tool.raw);
      return allowed.length ? [[member.id, [...new Set(allowed)].sort()]] : [];
    }));
    const tools = [...new Set(Object.values(memberTools).flat())].sort();
    if (!tools.length) continue;
    const name = row.name.replaceAll("_", "-");
    const config = row.config ?? {};
    const vendor = Object.hasOwn(sharedVendors, row.name) ? sharedVendors[row.name] : undefined;
    const useShared = turn.executor === "connector" && vendor && (config[vendor.urlKey] === undefined || config[vendor.urlKey] === vendor.url);
    targets.push({
      name, id: row.id, source: "org", members: Object.keys(memberTools).sort(), tools, memberTools,
      ...(useShared ? { placement: "shared" } : {}),
      ...(turn.executor === "mcp" && config.mcp?.envelope !== false ? { identityEnvelope: true } : {}),
    });
  }
  assert.ok(targets.length, "no MCP inventory can be published");
  console.log(JSON.stringify({ org, targets }));
} finally {
  await ctx.close();
}
