#!/usr/bin/env bash
set -euo pipefail

config="${1:?usage: verify-vendor-discovery.sh KUBECONFIG}"
[[ "$(kubectl --kubeconfig "$config" config current-context)" == k3d-guild-agent-experiment ]]
kube=(kubectl --kubeconfig "$config" -n guild-experiment)
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
umask 077
work="$(mktemp -d)"
org="$(cat /proc/sys/kernel/random/uuid)"
member="$(cat /proc/sys/kernel/random/uuid)"
backend="guild-mcp-$org"
cleanup() {
  "${kube[@]}" delete "httproute/$backend" "agentgatewaypolicy/$backend" "agentgatewaybackend/$backend" --ignore-not-found >/dev/null || true
  for name in "${services[@]}"; do
    "${kube[@]}" delete "deployment/$name" "service/$name" "networkpolicy/$name" "secret/$name-settings" "secret/$name-access" --ignore-not-found --wait=false >/dev/null || true
  done
  rm -rf -- "$work"
}
services=()
trap cleanup EXIT
while read -r slug tool; do
  target="${slug//_/-}"
  name="guild-mcp-$target-${org//-/}"
  services+=("$name")
  base_url="http://guild-mcp-fixture.guild-experiment.svc.cluster.local:8080"
  secrets='{}'
  case "$slug" in
    atlassian) secrets='{"token":"fixture-atlassian-token"}' ;;
    firecrawl) secrets='{"api_key":"fixture-firecrawl-token"}' ;;
    github) secrets='{"token":"fixture-github-token"}' ;;
    gitlab) secrets='{"token":"fixture-gitlab-token"}' ;;
    grafana) secrets='{"token":"fixture-grafana-token"}' ;;
    hubspot) secrets='{"token":"fixture-hubspot-token"}' ;;
    langfuse) secrets='{"public_key":"fixture-langfuse-public","secret_key":"fixture-langfuse-secret"}' ;;
    posthog) secrets='{"api_key":"fixture-posthog-token"}' ;;
    slack) secrets='{"bot_token":"fixture-slack-token"}' ;;
  esac
  jq -nc --arg url "$base_url" --argjson secrets "$secrets" \
    '{config:{base_url:$url,api_url:$url,site:$url,email:"fixture@example.org",project_id:1,org_id:7},secrets:$secrets}' > "$work/settings.json"
  "${kube[@]}" create secret generic "$name-settings" --from-file="settings.json=$work/settings.json" >/dev/null
  if [[ "$slug" == google_workspace ]]; then
    policy='{"delegatesActingIdentity":true}'
  else
    openssl rand -hex 32 | tr -d '\n' > "$work/access"
    "${kube[@]}" create secret generic "$name-access" --from-file="Authorization=$work/access" >/dev/null
    policy="$(jq -nc --arg name "$name-access" '{credentialSecret:$name}')"
  fi
  tools="$(jq -nc --arg tool "$tool" '[$tool]')"
  if [[ "$slug" == firecrawl ]]; then tools="$(jq -c '. + ["web_fetch"]' <<< "$tools")"; fi
  jq -nc --arg name "$target" --arg member "$member" --arg url "http://$name.guild-experiment.svc.cluster.local:8080/mcp" \
    --argjson tools "$tools" --argjson policy "$policy" '{name:$name,url:$url,members:[$member],tools:$tools} + $policy' >> "$work/targets"
  python3 render-connector.py "$slug" "$org" --tenant-isolated | "${kube[@]}" apply --server-side -f - >/dev/null
done <<'CONNECTORS'
atlassian jira_search
firecrawl web_search
github search_repositories
gitlab list_projects
google_workspace gmail_search
grafana list_datasources
hubspot search_contacts
langfuse list_traces
posthog query
searxng web_search
slack conversations_list
CONNECTORS
deployments=()
for name in "${services[@]}"; do deployments+=("deployment/$name"); done
"${kube[@]}" wait --for=condition=Available --timeout=90s "${deployments[@]}" >/dev/null
jq -s --arg org "$org" '{org:$org,targets:.}' "$work/targets" > "$work/inventory.json"
python3 render-org-mcp.py "$work/inventory.json" | "${kube[@]}" apply --server-side -f - >/dev/null
expected="$(jq -sc '[.[] | .name as $name | .tools[] | $name + "_" + .] | sort' "$work/targets")"
"${kube[@]}" exec -i deployment/guild -c server -- env ORG="$org" MEMBER="$member" EXPECTED="$expected" bun run - <<'PROBE'
import assert from "node:assert/strict";
import { AgentGateway } from "./src/platform/agentgateway.ts";
import { mcpConnect } from "./src/integrations/mcp.ts";
const gateway = new AgentGateway({
  url: process.env.GUILD_AGENTGATEWAY_URL,
  issuer: process.env.GUILD_AGENTGATEWAY_ISSUER,
  signingKeyPath: process.env.GUILD_AGENTGATEWAY_SIGNING_KEY_FILE,
});
const { url, headers } = gateway.mcp(process.env.ORG, process.env.MEMBER);
const expected = JSON.parse(process.env.EXPECTED);
let client;
for (let attempt = 0; ; attempt++) {
  try {
    client = await mcpConnect(url, headers);
    assert.deepEqual((await client.listTools()).map(({name}) => name).sort(), expected);
    break;
  } catch (error) {
    if (attempt === 14) throw error;
    await Bun.sleep(1000);
  }
}
console.log(`Discovered ${expected.length} allowed tools from the deployed vendor connectors`);
for (const [tool, args, content] of [
  ["atlassian_jira_search", {jql:"project = GUILD"}, /GUILD-1.*Fixture issue/],
  ["firecrawl_web_search", {query:"guild"}, /Guild fixture result/],
  ["github_search_repositories", {query:"guild"}, /fixture\/guild/],
  ["gitlab_list_projects", {search:"guild"}, /Guild fixture project/],
  ["grafana_list_datasources", {}, /Guild fixture metrics/],
  ["hubspot_search_contacts", {query:"Guild"}, /fixture@example\.org/],
  ["langfuse_list_traces", {limit:1}, /Guild fixture trace/],
  ["posthog_query", {query:"SELECT 1 AS guild_fixture"}, /guild_fixture\n1/],
  ["searxng_web_search", {query:"guild"}, /query: guild/],
  ["slack_conversations_list", {limit:1}, /guild-fixture/],
]) {
  const result = await client.callTool(tool, args);
  assert.equal(result.isError, false, result.content);
  assert.match(result.content, content);
  console.log(`${tool} forwarded credentials and returned fixture data`);
}
const fetched = await client.callTool("firecrawl_web_fetch", { url: "https://example.org/" });
assert.equal(fetched.isError, false, fetched.content);
assert.match(fetched.content, /Example Domain/);
assert.equal(fetched.structuredContent?.guildMeta?.engine, "curl");
console.log("Firecrawl fell back to the in-cluster curl-fetch service");
PROBE
