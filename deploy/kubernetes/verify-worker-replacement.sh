#!/usr/bin/env bash
set -euo pipefail

config="${1:?usage: verify-worker-replacement.sh KUBECONFIG}"
[[ "$(kubectl --kubeconfig "$config" config current-context)" == k3d-guild-agent-experiment ]]
kube=(kubectl --kubeconfig "$config" -n guild-experiment)
ate=(kubectl-ate --kubeconfig "$config" --preview)
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
name="replace-probe-$(openssl rand -hex 6)"
agent="$(cat /proc/sys/kernel/random/uuid)"
marker="$(openssl rand -hex 16)"
cleanup() {
  "${ate[@]}" delete actor "$name" -a guild-experiment >/dev/null 2>&1 || true
  "${ate[@]}" delete actor-template "$name" -a guild-experiment >/dev/null 2>&1 || true
  "${kube[@]}" delete "pod/$name" "workerpool/$name" --ignore-not-found --wait=false >/dev/null || true
  kubectl --kubeconfig "$config" delete "storageclass/guild-$name" --ignore-not-found >/dev/null || true
}
trap cleanup EXIT

sed -e "s/^  name: guild-actor-workers$/  name: $name/" -e "s/guild.dev\/workload: sandbox/guild.dev\/workload: $name/" \
  -e 's/^  replicas: 3$/  replicas: 1/' worker-pool.yaml | "${kube[@]}" apply --server-side -f - >/dev/null
sed "s/^  name: guild-actor-router-probe$/  name: $name/" actor-router-probe.yaml | "${kube[@]}" apply --server-side -f - >/dev/null
"${kube[@]}" wait --for=condition=Ready "pod/$name" --timeout=60s >/dev/null

worker_pod() {
  "${kube[@]}" get pods -l "ate.dev/worker-pool=$name" -o json |
    jq -er '.items[] | select(.metadata.deletionTimestamp == null and any(.status.conditions[]?; .type == "Ready" and .status == "True")) | .metadata.name'
}
wait_for_worker() {
  local pod
  for _ in {1..60}; do
    if pod="$(worker_pod)" && [[ -n "$pod" ]]; then printf '%s\n' "$pod"; return; fi
    sleep 1
  done
  return 1
}
original="$(wait_for_worker)"
image=$("${kube[@]}" get configmap guild-actor-image -o 'jsonpath={.data.reference}')
./create-workspace-probe.sh "$config" "$image" "$name" "$agent" "$name"
probe() {
  "${kube[@]}" exec -i "$name" -- env "ACTOR_NAME=$name" "PROBE_PHASE=$1" "PROBE_PATH=$2" "PROBE_VALUE=$marker" bun run - < probe-actor-rpc.mjs
}
probe write /home/node/snapshot-marker.txt
probe write /workspace/juicefs-marker.txt
"${ate[@]}" suspend actor "$name" -a guild-experiment --mode sync >/dev/null
"${ate[@]}" get actor "$name" -a guild-experiment -o json | jq -e '.status.state == "ACTOR_STATE_SUSPENDED"' >/dev/null
# This is the only pod in the disposable worker pool.
"${kube[@]}" delete "pod/$original" --timeout=60s >/dev/null
replacement="$(wait_for_worker)"
[[ "$replacement" != "$original" ]]
probe read /home/node/snapshot-marker.txt
probe read /workspace/juicefs-marker.txt
printf 'Actor restored its local filesystem and mounted JuiceFS after worker replacement (%s → %s).\n' "$original" "$replacement"
