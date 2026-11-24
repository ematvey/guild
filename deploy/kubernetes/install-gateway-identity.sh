#!/usr/bin/env bash
set -euo pipefail
kubeconfig="${1:?usage: install-gateway-identity.sh KUBECONFIG}"
[[ "$(kubectl --kubeconfig "$kubeconfig" config current-context)" == k3d-guild-agent-experiment ]]
kube=(kubectl --kubeconfig "$kubeconfig" -n guild-experiment)

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [[ -z "$("${kube[@]}" get secret guild-agentgateway-signing --ignore-not-found -o name)" ]]; then
  openssl genpkey -quiet -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$work/signing.pem"
  "${kube[@]}" create secret generic guild-agentgateway-signing --from-file=signing.pem="$work/signing.pem"
else
  "${kube[@]}" get secret guild-agentgateway-signing -o jsonpath='{.data.signing\.pem}' | base64 -d > "$work/signing.pem"
fi
openssl pkey -in "$work/signing.pem" -pubout -out "$work/issuer.pem"
"${kube[@]}" create configmap guild-agentgateway-issuer --from-file=issuer.pem="$work/issuer.pem" --dry-run=client -o yaml |
  "${kube[@]}" apply --server-side -f -
jwks="$(node -e 'const { createPublicKey } = require("node:crypto"); const { readFileSync } = require("node:fs"); const key = createPublicKey(readFileSync(process.argv[1])).export({format:"jwk"}); console.log(JSON.stringify({keys:[{...key,alg:"RS256",kid:"guild-workload",use:"sig"}]}));' "$work/signing.pem")"

"${kube[@]}" apply --server-side -f - <<YAML
apiVersion: agentgateway.dev/v1alpha1
kind: AgentgatewayPolicy
metadata:
  name: guild-workload-jwt
  namespace: guild-experiment
spec:
  targetRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: guild-ai
  traffic:
    jwtAuthentication:
      mode: Strict
      providers:
        - issuer: https://guild-agent-experiment.invalid
          audiences: [guild-agentgateway]
          jwks:
            inline: '$jwks'
YAML
