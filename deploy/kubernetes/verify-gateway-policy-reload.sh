#!/usr/bin/env bash
set -euo pipefail

config="${1:?usage: verify-gateway-policy-reload.sh KUBECONFIG}"
[[ "$(kubectl --kubeconfig "$config" config current-context)" == k3d-guild-agent-experiment ]]
kube=(kubectl --kubeconfig "$config" -n guild-experiment)
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
umask 077
work=$(mktemp -d)
org=$(cat /proc/sys/kernel/random/uuid)
name="guild-mcp-$org"
chat="00000000-0000-4000-8000-000000000017"
cleanup() {
  if [[ -n "${probe:-}" ]]; then kill "$probe" 2>/dev/null || true; fi
  "${kube[@]}" delete "httproute/$name" "agentgatewaypolicy/$name" "agentgatewaybackend/$name" --ignore-not-found >/dev/null
  rm -rf -- "$work"
}
trap cleanup EXIT

jq --arg org "$org" --arg chat "$chat" '.org = $org | (.targets[] | select(.name == "personal") | .chats) = [$chat]' \
  fixtures/personal-mcp.json > "$work/initial.json"
jq '(.targets[] | select(.name == "personal") | .members) = []' "$work/initial.json" > "$work/revoked.json"
apply_policy() {
  python3 render-org-mcp.py "$1" | "${kube[@]}" apply --server-side -f - >/dev/null
}
apply_policy "$work/initial.json"
for attempt in {1..12}; do
  if "${kube[@]}" exec -i deployment/guild -c server -- env PROBE_ORG="$org" PROBE_CHAT="$chat" bun run - \
    < fixtures/verify-personal-mcp.mjs > "$work/ready" 2>&1; then break; fi
  if (( attempt == 12 )); then cat "$work/ready"; exit 1; fi
  sleep 1
done
"${kube[@]}" exec -i deployment/guild -c server -- env PROBE_ORG="$org" PROBE_CHAT="$chat" PROBE_POLICY_RELOAD=1 bun run - \
  < fixtures/verify-personal-mcp.mjs > "$work/probe" 2>&1 &
probe=$!
for attempt in {1..18}; do
  if rg -q 'Waiting for gateway policy revocation' "$work/probe"; then break; fi
  if ! kill -0 "$probe" 2>/dev/null || (( attempt == 18 )); then cat "$work/probe"; exit 1; fi
  sleep 1
done
apply_policy "$work/revoked.json"
wait "$probe" || { cat "$work/probe"; exit 1; }
cat "$work/probe"
