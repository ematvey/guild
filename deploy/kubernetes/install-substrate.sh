#!/usr/bin/env bash
set -euo pipefail

kubeconfig="${1:?usage: install-substrate.sh KUBECONFIG SUBSTRATE_CHECKOUT}"
substrate_checkout="${2:?provide the Agent Substrate v1.0.1 checkout}"
kubeconfig="$(realpath "$kubeconfig")"
context="$(kubectl --kubeconfig "$kubeconfig" config current-context)"
if [[ "$context" != k3d-guild-agent-experiment ]]; then
  printf 'Expected the guild-agent-experiment context, got %s\n' "$context" >&2
  exit 1
fi
cd -- "$substrate_checkout"
if [[ "$(git rev-parse HEAD)" != 20778a6dbb01f13024642851bb592bf67c9fec05 ]]; then
  printf 'Check out the Agent Substrate v1.0.1 release first\n' >&2
  exit 1
fi

go run ./cmd/ate-setup deploy ate-system \
  --kubeconfig "$kubeconfig" --context "$context" --kind --no-dev-env \
  --image-repo ghcr.io/agent-substrate/substrate --image-tag v1.0.1 \
  --sandbox-classes gvisor --preview ExternalVolumes --rollout-timeout 180s \
  --credential-provider '{"enabled":false}' \
  --ingress-allowed-spiffe-ids spiffe://cluster.local/ns/guild-experiment/sa/guild-substrate
