#!/usr/bin/env bash
set -euo pipefail
config="${1:?usage: verify-default-dev.sh KUBECONFIG GUILD_HTTPS_ORIGIN NAMESPACE CONTEXT [PLAIN_WORKSPACE_ROOT]}"
origin="${2:?provide the Guild HTTPS origin}"
namespace="${3:?provide the Kubernetes namespace}"
context="${4:?provide the Kubernetes context}"
kube=(kubectl --kubeconfig "$config" --context "$context" -n "$namespace")
fixtures="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/fixtures" && pwd)"
"${kube[@]}" rollout status deployment/guild deployment/guild-substrate --timeout=60s
"${kube[@]}" rollout status daemonset/guild-workspace-csi --timeout=60s
if [[ -n "$("${kube[@]}" get daemonset guild-juicefs --ignore-not-found -o name)" ]]; then
  "${kube[@]}" rollout status daemonset/guild-juicefs --timeout=60s
fi
"${kube[@]}" exec -i deploy/guild -c server -- env PROBE_PLAIN_WORKSPACE_ROOT="${5:-}" bun - < "$fixtures/verify-dev-workspaces.mjs"
"${kube[@]}" exec -i deploy/guild -c server -- env PROBE_GUILD_ORIGIN="$origin" bun - < "$fixtures/verify-dev-chat.mjs"
