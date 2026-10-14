#!/usr/bin/env bash
# Sandbox integration tests against a real runner + gVisor + egress proxy.
# Builds the images under the `sbx-it` tag (unless SKIP_BUILD=1), starts the
# guild-sbx-it compose project, runs the gated vitest suite, tears it all
# down (sandbox containers included). Requires the runsc runtime on the
# host Docker daemon.
set -euo pipefail
cd "$(dirname "$0")/.."
TAG=${TAG:-sbx-it}
export GUILD_TS_SERVER_IMAGE=guild-server-ts:$TAG
export GUILD_SANDBOX_IMAGE=guild-sandbox:$TAG
export GUILD_SANDBOX_EGRESS_IMAGE=guild-sandbox-egress:$TAG
export GUILD_SANDBOX_RUNNER_TOKEN=${GUILD_SANDBOX_RUNNER_TOKEN:-$(openssl rand -hex 24)}
export GUILD_SANDBOX_IT_PORT=${GUILD_SANDBOX_IT_PORT:-18090}
PROJECT=guild-sbx-it
compose() { docker compose -p "$PROJECT" -f deploy/sandbox/it/docker-compose.yml "$@"; }

if [ "${SKIP_BUILD:-0}" != 1 ]; then
  docker build -q -f Dockerfile.server-ts -t "$GUILD_TS_SERVER_IMAGE" . >/dev/null
  docker build -q -f Dockerfile.sandbox -t "$GUILD_SANDBOX_IMAGE" . >/dev/null
  docker build -q -t "$GUILD_SANDBOX_EGRESS_IMAGE" deploy/sandbox/egress >/dev/null
fi

cleanup() {
  docker ps -aq --filter "label=guild.sandbox.project=$PROJECT" | xargs -r docker rm -f >/dev/null
  compose down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
compose up -d
for _ in $(seq 1 60); do
  curl -sf -H "authorization: Bearer $GUILD_SANDBOX_RUNNER_TOKEN" "http://127.0.0.1:$GUILD_SANDBOX_IT_PORT/v1/healthz" >/dev/null && break
  sleep 1
done
curl -sf -H "authorization: Bearer $GUILD_SANDBOX_RUNNER_TOKEN" "http://127.0.0.1:$GUILD_SANDBOX_IT_PORT/v1/healthz" || { compose logs sandbox-runner; exit 1; }
echo

GUILD_SANDBOX_IT_URL="http://127.0.0.1:$GUILD_SANDBOX_IT_PORT" \
GUILD_SANDBOX_IT_PROJECT=$PROJECT \
  npx --workspace apps/server vitest run src/test/sandbox/runner.it.test.ts src/test/sandbox/server-e2e.it.test.ts "$@" || { compose logs sandbox-runner | tail -50; exit 1; }
