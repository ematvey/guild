#!/usr/bin/env bash
set -euo pipefail

kubeconfig="${1:?usage: install-agentgateway.sh KUBECONFIG}"
context="$(kubectl --kubeconfig "$kubeconfig" config current-context)"
if [[ "$context" != k3d-guild-agent-experiment ]]; then
  printf 'Expected the guild-agent-experiment context, got %s\n' "$context" >&2
  exit 1
fi
kube=(kubectl --kubeconfig "$kubeconfig" --context "$context")
charts=(helm --kubeconfig "$kubeconfig" --kube-context "$context")
namespace=agentgateway-system
version=v1.7.0

"${kube[@]}" apply --server-side -f https://github.com/kubernetes-sigs/gateway-api/releases/download/v1.6.3/standard-install.yaml
"${charts[@]}" upgrade --install agentgateway-crds oci://cr.agentgateway.dev/charts/agentgateway-crds \
  --create-namespace --namespace "$namespace" --version "$version"
"${charts[@]}" upgrade --install agentgateway oci://cr.agentgateway.dev/charts/agentgateway \
  --namespace "$namespace" --version "$version"
"${kube[@]}" rollout status -n "$namespace" deployment/agentgateway --timeout=180s
"${kube[@]}" wait --for=condition=Accepted gatewayclass/agentgateway --timeout=60s
