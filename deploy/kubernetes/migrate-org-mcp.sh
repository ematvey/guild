#!/usr/bin/env bash
set -euo pipefail

kubeconfig="${1:?usage: migrate-org-mcp.sh KUBECONFIG PLAN_JSON [--default-dev] [--refresh-tenant SLUG]}"
plan="${2:?provide the reviewed MCP migration plan}"
context="$(kubectl --kubeconfig "$kubeconfig" config current-context)"
[[ "$context" == k3d-guild-agent-experiment || ( "$context" == default && "${3:-}" == --default-dev ) ]]
shift 2
if [[ "${1:-}" == --default-dev ]]; then shift; fi
refresh=
if [[ "${1:-}" == --refresh-tenant ]]; then
  refresh="${2:?provide the tenant connector slug}"
  [[ "$refresh" =~ ^[a-z0-9][a-z0-9_-]*$ ]]
  shift 2
fi
[[ "$#" == 0 ]]
renderer_options=()
if [[ "$context" == default && -z "$refresh" ]]; then
  renderer_options+=(--image "${GUILD_MCP_CONNECTOR_IMAGE:?set the deployed Guild image reference}"
                    --issuer "${GUILD_AGENTGATEWAY_ISSUER:?set the Guild gateway token issuer}")
  if [[ -n "${GUILD_MCP_HOST_GATEWAY_IP:-}" ]]; then
    renderer_options+=(--host-gateway-ip "$GUILD_MCP_HOST_GATEWAY_IP")
  fi
fi
kube=(kubectl --kubeconfig "$kubeconfig" --context "$context" -n guild-experiment)
manifest_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
umask 077
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

if [[ -n "$refresh" ]]; then
  jq -e --arg name "${refresh//_/-}" '
    .targets |= map(select(.name == $name and .source == "org" and .placement != "shared")) |
    select(.targets | length == 1)
  ' "$plan" > "$work/refresh.json"
  plan="$work/refresh.json"
fi
"${kube[@]}" exec -i deployment/guild -c server -- \
  bun src/integrations/export-gateway-mcp.ts /dev/stdin < "$plan" > "$work/export.json"
jq -e '.inventory' "$work/export.json" > "$work/inventory.json"
jq -e '.secrets' "$work/export.json" > "$work/secrets.json"
jq -r '.connectors[]' "$work/export.json" > "$work/connectors"
jq -r '.sharedConnectors[]?' "$work/export.json" > "$work/shared-connectors"
jq -r '.legacyProxies[]' "$work/export.json" > "$work/proxies"
org="$(jq -re .org "$work/inventory.json")"
if [[ -n "$refresh" ]]; then
  [[ "$(cat "$work/connectors")" == "$refresh" && ! -s "$work/shared-connectors" && ! -s "$work/proxies" ]]
  deployment="guild-mcp-${refresh//_/-}-${org//-/}"
  settings="$deployment-settings"
  # Confirm this is the published connector before changing its settings.
  "${kube[@]}" get agentgatewaybackend "guild-mcp-$org" -o json |
    jq -e --arg target "${refresh//_/-}" --arg host "$deployment.guild-experiment.svc.cluster.local" '
      any(.spec.mcp.targets[]; .name == $target and .static.host == $host and .static.path == "/mcp")
    ' >/dev/null
  "${kube[@]}" get "deployment/$deployment" -o name >/dev/null
  "${kube[@]}" get "secret/$settings" -o json > "$work/current-settings.json"
  jq -e --arg settings "$settings" '[.items[] | select(.metadata.name == $settings)] |
    if length == 1 then .[0] else error("expected one tenant settings Secret") end' "$work/secrets.json" > "$work/new-settings.json"
  if ! jq -n -e --slurpfile current "$work/current-settings.json" --slurpfile next "$work/new-settings.json" '
    ($current[0].data["settings.json"] | @base64d | fromjson | .config) ==
    ($next[0].data["settings.json"] | @base64d | fromjson | .config)' >/dev/null; then
    echo "Connector configuration changed. Republish the reviewed inventory." >&2
    exit 1
  fi
  if jq -n -e --slurpfile current "$work/current-settings.json" --slurpfile next "$work/new-settings.json" '
    ($current[0].data["settings.json"] | @base64d | fromjson) ==
    ($next[0].data["settings.json"] | @base64d | fromjson)' >/dev/null; then
    printf '%s settings already match Guild.\n' "$deployment"
    exit 0
  fi
  "${kube[@]}" apply --server-side -f "$work/new-settings.json"
  "${kube[@]}" rollout restart "deployment/$deployment"
  "${kube[@]}" rollout status "deployment/$deployment" --timeout=90s
  exit
fi
# Reconciliation keeps existing transport keys stable. Vendor credentials
# can change independently of the connector-to-gateway authentication.
jq -r '.items[].metadata.name | select(endswith("-access"))' "$work/secrets.json" > "$work/access-keys"
while read -r key; do
  if [[ -n "$("${kube[@]}" get secret "$key" --ignore-not-found -o name)" ]]; then
    jq --arg key "$key" '.items |= map(select(.metadata.name != $key))' "$work/secrets.json" > "$work/secrets-next.json"
    mv -- "$work/secrets-next.json" "$work/secrets.json"
  fi
done < "$work/access-keys"
python3 "$manifest_dir/render-org-mcp.py" "$work/inventory.json" > "$work/gateway.json"
"${kube[@]}" apply --server-side --dry-run=server -f "$work/gateway.json" >/dev/null
if jq -e '.items | length > 0' "$work/secrets.json" >/dev/null; then
  "${kube[@]}" apply --server-side -f "$work/secrets.json"
fi
while read -r shared; do
  deployment="guild-mcp-${shared//_/-}"
  access="$deployment-access"
  if ! "${kube[@]}" get secret "$access" >/dev/null 2>&1; then
    openssl rand -hex 32 | tr -d '\n' > "$work/shared-access"
    "${kube[@]}" create secret generic "$access" --from-file=Authorization="$work/shared-access" >/dev/null
  fi
  python3 "$manifest_dir/render-connector.py" "$shared" --shared "${renderer_options[@]}" | "${kube[@]}" apply --server-side -f -
  "${kube[@]}" rollout status "deployment/$deployment" --timeout=90s
done < "$work/shared-connectors"
while read -r connector; do
  python3 "$manifest_dir/render-connector.py" "$connector" "$org" --tenant-isolated "${renderer_options[@]}" |
    "${kube[@]}" apply --server-side -f -
  deployment="guild-mcp-${connector//_/-}-${org//-/}"
  "${kube[@]}" rollout restart "deployment/$deployment"
  "${kube[@]}" rollout status "deployment/$deployment" --timeout=90s
done < "$work/connectors"
while read -r proxy; do
  python3 "$manifest_dir/render-connector.py" "$proxy" "$org" --legacy-proxy "${renderer_options[@]}" |
    "${kube[@]}" apply --server-side -f -
  deployment="guild-mcp-envelope-$proxy"
  "${kube[@]}" rollout restart "deployment/$deployment"
  "${kube[@]}" rollout status "deployment/$deployment" --timeout=90s
done < "$work/proxies"
"${kube[@]}" apply --server-side -f "$work/gateway.json"
