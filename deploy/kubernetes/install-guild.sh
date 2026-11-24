#!/usr/bin/env bash
set -euo pipefail

kubeconfig="${1:?usage: install-guild.sh KUBECONFIG}"
context="$(kubectl --kubeconfig "$kubeconfig" config current-context)"
if [[ "$context" != k3d-guild-agent-experiment ]]; then
  printf 'Expected the guild-agent-experiment context, got %s\n' "$context" >&2
  exit 1
fi
kube=(kubectl --kubeconfig "$kubeconfig" --context "$context")
manifest_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
namespace=guild-experiment

if [[ -z "$("${kube[@]}" -n "$namespace" get secret guild-server --ignore-not-found -o name)" ]]; then
  {
    for name in GUILD_MASTER_KEY_HEX GUILD_JWT_SECRET GUILD_INTERNAL_KEY GUILD_SANDBOX_RUNNER_TOKEN; do
      printf '%s=%s\n' "$name" "$(openssl rand -hex 32)"
    done
  } | "${kube[@]}" -n "$namespace" create secret generic guild-server --from-env-file=/dev/stdin
fi
"${kube[@]}" apply --server-side -f "$manifest_dir/guild.yaml"
