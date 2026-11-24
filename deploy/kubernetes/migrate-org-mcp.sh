#!/usr/bin/env bash
set -euo pipefail

kubeconfig="${1:?usage: migrate-org-mcp.sh KUBECONFIG PLAN_JSON}"
plan="${2:?provide the reviewed MCP migration plan}"
context="$(kubectl --kubeconfig "$kubeconfig" config current-context)"
[[ "$context" == k3d-guild-agent-experiment ]]
kube=(kubectl --kubeconfig "$kubeconfig" --context "$context" -n guild-experiment)
manifest_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
umask 077
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT

"${kube[@]}" exec -i deployment/guild -c server -- \
  bun src/integrations/export-gateway-mcp.ts /dev/stdin < "$plan" > "$work/export.json"
jq -e '.inventory' "$work/export.json" > "$work/inventory.json"
jq -e '.secrets' "$work/export.json" > "$work/secrets.json"
jq -r '.connectors[]' "$work/export.json" > "$work/connectors"
jq -r '.legacyProxies[]' "$work/export.json" > "$work/proxies"
org="$(jq -re .org "$work/inventory.json")"
python3 "$manifest_dir/render-org-mcp.py" "$work/inventory.json" > "$work/gateway.json"
"${kube[@]}" apply --server-side --dry-run=server -f "$work/gateway.json" >/dev/null
"${kube[@]}" apply --server-side -f "$work/secrets.json"
while read -r connector; do
  python3 "$manifest_dir/render-connector.py" "$connector" "$org" --tenant-isolated |
    "${kube[@]}" apply --server-side -f -
  deployment="guild-mcp-${connector//_/-}-${org//-/}"
  "${kube[@]}" rollout restart "deployment/$deployment"
  "${kube[@]}" rollout status "deployment/$deployment" --timeout=90s
done < "$work/connectors"
while read -r proxy; do
  python3 "$manifest_dir/render-connector.py" "$proxy" "$org" --legacy-proxy |
    "${kube[@]}" apply --server-side -f -
  deployment="guild-mcp-envelope-$proxy"
  "${kube[@]}" rollout restart "deployment/$deployment"
  "${kube[@]}" rollout status "deployment/$deployment" --timeout=90s
done < "$work/proxies"
"${kube[@]}" apply --server-side -f "$work/gateway.json"
