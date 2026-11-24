#!/usr/bin/env bash
set -euo pipefail

kubeconfig="${1:?usage: verify-workspace-isolation.sh KUBECONFIG}"
probe_pod="${2:-guild-actor-router-probe}"
context="$(kubectl --kubeconfig "$kubeconfig" config current-context)"
[[ "$context" == k3d-guild-agent-experiment ]]
kube=(kubectl --kubeconfig "$kubeconfig" -n guild-experiment)
ate=(kubectl-ate --kubeconfig "$kubeconfig" --preview)
manifest_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
marker="$(openssl rand -hex 16)"
file="isolation-probe-$marker.txt"

probe() {
  "${kube[@]}" exec -i "$probe_pod" -- env \
    ACTOR_NAME="$1" PROBE_PHASE="$2" PROBE_VALUE="$3" PROBE_PATH="/workspace/$file" bun - \
    < "$manifest_dir/probe-actor-rpc.mjs"
}

probe juice-probe-a write "$marker"
probe juice-probe-b absent ""
probe juice-probe-b write "second-$marker"
"${ate[@]}" suspend actor juice-probe-a -a guild-experiment
"${ate[@]}" get actor juice-probe-a -a guild-experiment -o json |
  jq -e '.status.state == "ACTOR_STATE_SUSPENDED"' >/dev/null

observed="$("${kube[@]}" exec deploy/guild -- cat "/juicefs/volume/agents/00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/$file")"
[[ "$observed" == "$marker" ]]
probe juice-probe-a read "$marker"
probe juice-probe-b read "second-$marker"
"${ate[@]}" get actor juice-probe-a -a guild-experiment -o json |
  jq -e '.status.state == "ACTOR_STATE_RUNNING"' >/dev/null
