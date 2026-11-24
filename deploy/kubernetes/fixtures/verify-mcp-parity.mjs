import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { PlatformContext } from "./src/composition.ts";
import { loadConfig } from "./src/config.ts";
import { AgentGateway } from "./src/platform/agentgateway.ts";
import { IntegrationAccessStore } from "./src/platform/store/integration-access.ts";
import { callPlugin } from "./src/integrations/execute.ts";
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
    return { tools, turns, warnings, agentGateway };
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
    if (process.env.PROBE_EXECUTE_READS === "1" && !process.exitCode) {
      const reads = {
        atlassian: ["jira_search", { jql: 'text ~ "guild-mcp-parity-probe"', max_results: 1 }],
        firecrawl: ["web_search", { query: "example.org example domains", count: 1 }],
        github: ["search_repositories", { query: "repo:octocat/Hello-World", per_page: 1 }],
        gitlab: ["list_projects", { search: "guild-mcp-parity-probe", per_page: 1 }],
        google_workspace: ["drive_search", { name: "guild-mcp-parity-probe", max_results: 1 }],
        grafana: ["list_dashboards", { query: "guild-mcp-parity-probe", limit: 1 }],
        hubspot: ["search_contacts", { query: "guild-mcp-parity-probe", limit: 1 }],
        posthog: ["list_dashboards", { limit: 1 }],
        slack: ["conversations_list", { limit: 1 }],
        stripe: ["get_stripe_account_info", {}],
      };
      async function run(path, slug, raw, args) {
        const turn = path.turns.find(({ slug: target }) => target === slug);
        const info = turn?.tools.find((tool) => tool.raw === raw);
        if (!info || path.tools.get(info.spec.name)?.class !== "read") return "ineligible";
        try {
          const outcome = await callPlugin({ ...source, agentGateway: path.agentGateway }, turn, raw, args, {
            orgId: org, callerId: user.id, actingAs: user.email, callId: crypto.randomUUID(),
          }, AbortSignal.timeout(30000));
          return typeof outcome.content === "string" && outcome.content.length > 0 ? "success" : "empty result";
        } catch (error) {
          const status = /(?:auth failed \(|returned )(\d{3})/.exec(String(error))?.[1];
          return status ? `failed HTTP ${status}` : "failed";
        }
      }
      for (const [target, [tool, args]] of Object.entries(reads)) {
        const [direct, gateway] = await Promise.all([
          run(baseline, target, tool, args), run(published, target, tool, args),
        ]);
        console.log(JSON.stringify({ target, tool, direct, gateway }));
        if (direct !== "success" || gateway !== "success") process.exitCode = 1;
      }
    }
  }
} finally {
  await ctx.close();
}
