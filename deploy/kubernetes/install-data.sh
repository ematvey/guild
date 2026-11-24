#!/usr/bin/env bash
set -euo pipefail

kubeconfig="${1:?usage: install-data.sh KUBECONFIG}"
context="$(kubectl --kubeconfig "$kubeconfig" config current-context)"
if [[ "$context" != k3d-guild-agent-experiment ]]; then
  printf 'Expected the guild-agent-experiment context, got %s\n' "$context" >&2
  exit 1
fi
kube=(kubectl --kubeconfig "$kubeconfig" --context "$context")
manifest_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
namespace=guild-experiment

"${kube[@]}" create namespace "$namespace" --dry-run=client -o yaml | "${kube[@]}" apply --server-side -f -
if ! "${kube[@]}" -n "$namespace" get secret guild-data --ignore-not-found -o name | grep -q '^secret/'; then
  {
    printf 'postgres-password=%s\n' "$(openssl rand -hex 24)"
    printf 'clickhouse-password=%s\n' "$(openssl rand -hex 24)"
    printf 'rustfs-password=%s\n' "$(openssl rand -hex 24)"
  } | "${kube[@]}" -n "$namespace" create secret generic guild-data --from-env-file=/dev/stdin
fi
if ! "${kube[@]}" -n "$namespace" get secret guild-postgres-tls --ignore-not-found -o name | rg -q '^secret/'; then
  (
    umask 077
    tls_dir="$(mktemp -d)"
    trap 'rm -rf -- "$tls_dir"' EXIT
    hostname=postgres.guild-experiment.svc.cluster.local
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=$hostname" \
      -addext "subjectAltName=DNS:$hostname" -keyout "$tls_dir/tls.key" -out "$tls_dir/tls.crt" 2>/dev/null
    "${kube[@]}" -n "$namespace" create secret tls guild-postgres-tls \
      --cert="$tls_dir/tls.crt" --key="$tls_dir/tls.key"
  )
fi
"${kube[@]}" apply --server-side -f "$manifest_dir/data.yaml"
"${kube[@]}" -n "$namespace" wait --for=condition=Ready pod/rustfs-0 --timeout=180s
"${kube[@]}" apply --server-side -f "$manifest_dir/buckets.yaml"
"${kube[@]}" -n "$namespace" wait --for=condition=Complete job/guild-buckets --timeout=180s
"${kube[@]}" -n "$namespace" rollout status statefulset/postgres --timeout=180s
"${kube[@]}" apply --server-side -f "$manifest_dir/juicefs-format.yaml"
"${kube[@]}" -n "$namespace" wait --for=condition=Complete job/guild-juicefs-format --timeout=180s

"${kube[@]}" apply --server-side -f "$manifest_dir/juicefs-mount.yaml"
"${kube[@]}" -n "$namespace" rollout status daemonset/guild-juicefs --timeout=180s
