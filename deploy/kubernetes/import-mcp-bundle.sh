#!/usr/bin/env bash
set -euo pipefail

archive="${1:?usage: import-mcp-bundle.sh ARCHIVE APPROVED_SHA256}"
digest="${2:?usage: import-mcp-bundle.sh ARCHIVE APPROVED_SHA256}"
[[ "$digest" =~ ^[a-f0-9]{64}$ ]]
umask 077
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
cp -- "$archive" "$work/bundle.tar.gz"
if [[ "$(sha256sum < "$work/bundle.tar.gz")" != "$digest  -" ]]; then
  printf '%s\n' 'Bundle does not match the approved SHA-256.' >&2
  exit 1
fi
image="guild-k8s-mcp-bundle:$digest"
docker build --tag "$image" --file - "$work" <<'EOF'
FROM guild-k8s-server:experiment
COPY --chmod=0444 bundle.tar.gz /opt/guild-mcp-bundle.tar.gz
EOF
k3d image import --cluster guild-agent-experiment "$image"
