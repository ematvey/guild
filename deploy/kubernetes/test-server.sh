#!/usr/bin/env bash
set -euo pipefail

kubeconfig="${1:?usage: test-server.sh KUBECONFIG [VITEST_ARGS...]}"
shift
[[ "$(kubectl --kubeconfig "$kubeconfig" config current-context)" == k3d-guild-agent-experiment ]]
kube=(kubectl --kubeconfig "$kubeconfig" -n guild-experiment)
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd -- "$repo"
umask 077
work="$(mktemp -d)"
declare -a pids=()
cleanup() {
  local result=$?
  if (( result != 0 )); then
    for log in "$work"/postgres "$work"/clickhouse "$work"/rustfs "$work"/guild-substrate; do
      if [[ -f "$log" ]]; then tail -n 12 "$log" >&2; fi
    done
  fi
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for pid in "${pids[@]}"; do wait "$pid" 2>/dev/null || true; done
  rm -rf -- "$work"
}
trap cleanup EXIT

forward() {
  local service="$1" remote="$2" log="$work/$1" port
  "${kube[@]}" port-forward "service/$service" ":$remote" > "$log" 2>&1 &
  pids+=("$!")
  for _ in {1..75}; do
    port="$(sed -n 's/^Forwarding from 127\.0\.0\.1:\([0-9]*\) -> .*$/\1/p' "$log")"
    if [[ -n "$port" ]]; then
      export "$3=$port"
      return
    fi
    if ! kill -0 "${pids[-1]}" 2>/dev/null; then break; fi
    sleep .2
  done
  cat "$log" >&2
  return 1
}

if [[ -z "${GUILD_TEST_POSTGRES_ENDPOINT:-}" ]]; then
  forward postgres 5432 postgres_test_port
  GUILD_TEST_POSTGRES_ENDPOINT="127.0.0.1:$postgres_test_port"
fi
forward clickhouse 8123 clickhouse_test_port
forward rustfs 9000 rustfs_test_port
data_key() {
  "${kube[@]}" get secret guild-data -o "jsonpath={.data.$1}" | base64 -d
}

postgres_test_password="$(data_key postgres-password)"
export GUILD_TEST_PG_URL="postgres://guild:$postgres_test_password@$GUILD_TEST_POSTGRES_ENDPOINT/guild"
export GUILD_TEST_CLICKHOUSE_URL="http://127.0.0.1:$clickhouse_test_port"
export GUILD_TEST_CLICKHOUSE_USER=guild
export GUILD_TEST_CLICKHOUSE_PASSWORD="$(data_key clickhouse-password)"
export GUILD_CLICKHOUSE_USER="$GUILD_TEST_CLICKHOUSE_USER"
export GUILD_CLICKHOUSE_PASSWORD="$GUILD_TEST_CLICKHOUSE_PASSWORD"
export GUILD_TEST_S3_URL="http://127.0.0.1:$rustfs_test_port"
export GUILD_TEST_S3_ACCESS_KEY_ID=GUILDEXPERIMENT
export GUILD_TEST_S3_SECRET_ACCESS_KEY="$(data_key rustfs-password)"
if [[ "${GUILD_TEST_SUBSTRATE:-0}" == 1 ]]; then
  forward guild-substrate 8090 substrate_test_port
  export GUILD_SANDBOX_IT_RUNTIME=substrate
  export GUILD_SANDBOX_IT_URL="http://127.0.0.1:$substrate_test_port"
  export GUILD_SANDBOX_RUNNER_TOKEN="$("${kube[@]}" get secret guild-server -o jsonpath='{.data.GUILD_SANDBOX_RUNNER_TOKEN}' | base64 -d)"
  [[ -n "$GUILD_SANDBOX_RUNNER_TOKEN" ]]
fi
npm run test --workspace apps/server -- --maxWorkers="${GUILD_TEST_MAX_WORKERS:-5}" "$@" > "$work/vitest" 2>&1 || result=$?
sed -E 's/\x1B\[[0-9;]*[mK]//g' "$work/vitest" | sed -e '/Serialized Error:/d' \
  -e "s/$postgres_test_password/[redacted]/g" \
  -e "s/$GUILD_TEST_CLICKHOUSE_PASSWORD/[redacted]/g" \
  -e "s/$GUILD_TEST_S3_SECRET_ACCESS_KEY/[redacted]/g" \
  -e "s/${GUILD_SANDBOX_RUNNER_TOKEN:-unused-token-marker}/[redacted]/g"
exit "${result:-0}"
