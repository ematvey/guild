import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { PlatformContext } from "./src/composition.ts";
import { loadConfig } from "./src/config.ts";
import { AgentGateway } from "./src/platform/agentgateway.ts";
import { IntegrationAccessStore } from "./src/platform/store/integration-access.ts";
import { callerScope } from "./src/integrations/member-tools.ts";
import { resolveIntegrations } from "./src/integrations/plugins.ts";
import { scopeCeiling, toolCurate, toolOffered } from "./src/integrations/policy.ts";

const config = loadConfig();
assert.ok(config.agentGateway, "Guild needs a configured MCP gateway");
const ctx = new PlatformContext(config);
try {
  const user = await ctx.identity.getUser(process.env.PROBE_MEMBER_ID);
  const org = user.org_id;
  const scope = await callerScope(new IntegrationAccessStore(ctx.pool), {
    org, userId: user.id, email: user.email, role: user.role,
  });
  const source = {
    integrations: ctx.integrations,
    integrationSecrets: ctx.integrationSecrets,
    registry: ctx.registry,
    objects: ctx.objects,
    orgKv: ctx.orgKv,
    masterKey: () => ctx.masterKey(),
  };
  async function snapshot(agentGateway) {
    let warnings = 0;
    const turns = await resolveIntegrations({ ...source, agentGateway }, org, () => warnings++, user.id);
    const tools = new Map();
    for (const turn of turns) {
      for (const tool of turn.tools) {
        if (!toolOffered(turn, tool, scopeCeiling(scope, turn.slug, tool), user.role)) continue;
        tools.set(tool.spec.name, {
          class: tool.class,
          parameters: tool.spec.parameters,
          trait: tool.trait ?? null,
          impersonated: turn.impersonated === true,
          approval: toolCurate(turn.rowConfig, tool.raw),
        });
      }
    }
    return { tools, warnings };
  }
  const baseline = await snapshot(null);
  assert.ok(baseline.tools.size, "the selected member has no baseline tools");
  if (process.env.PROBE_BASELINE_ONLY === "1") {
    console.log(JSON.stringify({ directTools: baseline.tools.size, discoveryWarnings: baseline.warnings }));
  } else {
    const published = await snapshot(new AgentGateway({
      ...config.agentGateway, serviceTokensOnly: false, mcpOnly: true,
    }));
    const missing = [...baseline.tools.keys()].filter((key) => !published.tools.has(key));
    const extra = [...published.tools.keys()].filter((key) => !baseline.tools.has(key));
    const changed = [...baseline.tools.keys()].filter((key) =>
      published.tools.has(key) && !isDeepStrictEqual(baseline.tools.get(key), published.tools.get(key)));
    console.log(JSON.stringify({
      directTools: baseline.tools.size, gatewayTools: published.tools.size,
      missing, extra, changed, warnings: { direct: baseline.warnings, gateway: published.warnings },
    }));
    if (missing.length || extra.length || changed.length || baseline.warnings || published.warnings) process.exitCode = 1;
  }
} finally {
  await ctx.close();
}
