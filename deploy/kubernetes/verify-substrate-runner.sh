#!/usr/bin/env bash
set -euo pipefail

kubeconfig="${1:?usage: verify-substrate-runner.sh KUBECONFIG [NAMESPACE] [ATESPACE] [CONTEXT]}"
namespace="${2:-guild-dev}"
atespace="${3:-$namespace}"
context="${4:-$(kubectl --kubeconfig "$kubeconfig" config current-context)}"
kube=(kubectl --kubeconfig "$kubeconfig" --context "$context" -n "$namespace")
ate=(kubectl-ate --kubeconfig "$kubeconfig" --context "$context" --preview)
manifest_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
org=00000000-0000-4000-8000-000000000001
agent="$(cat /proc/sys/kernel/random/uuid)"
marker="$(openssl rand -hex 16)"
probe() {
  "${kube[@]}" exec -i deploy/guild -c server -- env \
    SANDBOX_KEY="agent:$org:$agent" SANDBOX_SUBPATH="agents/$org/$agent" \
    PROBE_PHASE="$1" PROBE_VALUE="$marker" bun - < "$manifest_dir/probe-substrate-runner.mjs"
}

cleanup() {
  local result=$?
  if ! probe cleanup; then
    printf 'Could not clean up the runner probe Actor or workspace marker\n' >&2
    (( result != 0 )) || result=1
  fi
  exit "$result"
}
trap cleanup EXIT
name="$(probe write)"
printf '%s created and wrote through Guild RunnerClient\n' "$name"
suspended=false
for _ in {1..50}; do
  if "${ate[@]}" get actor "$name" -a "$atespace" -o json |
    jq -e '.status.state == "ACTOR_STATE_SUSPENDED"' >/dev/null; then
    suspended=true
    break
  fi
  sleep 2
done
[[ "$suspended" == true ]]
printf '%s suspended after disconnect\n' "$name"
[[ "$(probe read)" == "$name" ]]
"${ate[@]}" get actor "$name" -a "$atespace" -o json |
  jq -e '.status.state == "ACTOR_STATE_RUNNING"' >/dev/null
printf '%s resumed on demand and read the original file\n' "$name"
