#!/usr/bin/env bash
set -euo pipefail

kubeconfig="${1:?usage: publish-actor-image.sh KUBECONFIG [IMAGE]}"
image="${2:-guild-k8s-actor:experiment}"
repository=guild-sandbox
context="$(kubectl --kubeconfig "$kubeconfig" config current-context)"
if [[ "$context" != k3d-guild-agent-experiment ]]; then
  printf 'Expected the guild-agent-experiment context, got %s\n' "$context" >&2
  exit 1
fi
kube=(kubectl --kubeconfig "$kubeconfig" --context "$context")
manifest_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
"${kube[@]}" apply --server-side -f "$manifest_dir/actor-registry.yaml" >&2
"${kube[@]}" -n ate-system rollout status deployment/guild-actor-registry --timeout=90s >&2

forward_log="$(mktemp)"
"${kube[@]}" -n ate-system port-forward service/kind-registry :5000 >"$forward_log" 2>&1 &
forward_pid=$!
cleanup() {
  kill "$forward_pid" 2>/dev/null || true
  wait "$forward_pid" 2>/dev/null || true
  rm -f "$forward_log"
}
trap cleanup EXIT
for _ in {1..50}; do
  port="$(sed -n 's/^Forwarding from 127\.0\.0\.1:\([0-9]*\) -> 5000$/\1/p' "$forward_log")"
  [[ -n "$port" ]] && break
  kill -0 "$forward_pid" 2>/dev/null || break
  sleep .1
done
if [[ -z "$port" ]]; then
  cat "$forward_log" >&2
  exit 1
fi

local_registry="localhost:$port"
docker tag "$image" "$local_registry/$repository:experiment"
docker push "$local_registry/$repository:experiment" >&2
digest="$(docker image inspect "$local_registry/$repository:experiment" --format '{{range .RepoDigests}}{{println .}}{{end}}' |
  awk -v prefix="$local_registry/$repository@" 'index($0,prefix)==1 { print substr($0,length(prefix)+1) }')"
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
printf 'localhost:5000/%s@%s\n' "$repository" "$digest"
