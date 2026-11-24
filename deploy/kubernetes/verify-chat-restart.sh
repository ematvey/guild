#!/usr/bin/env bash
set -euo pipefail

config="${1:?usage: verify-chat-restart.sh KUBECONFIG [--postgres]}"
postgres_probe="${2:-}"
[[ -z "$postgres_probe" || "$postgres_probe" == --postgres ]]
[[ "$(kubectl --kubeconfig "$config" config current-context)" == k3d-guild-agent-experiment ]]
kube=(kubectl --kubeconfig "$config" -n guild-experiment)
ate=(kubectl-ate --kubeconfig "$config" --preview)
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
umask 077
work=$(mktemp -d)
fixture="/tmp/guild-mcp-restart-$(openssl rand -hex 8).mjs"
api() {
  "${kube[@]}" exec -i deployment/guild -c server -- bun -e '
    const [method, path] = process.argv.slice(1);
    const token = (await Bun.stdin.text()).trim();
    const response = await fetch(new URL(path, "http://127.0.0.1:8080"), {
      method, headers: {authorization: "Bearer " + token},
    });
    if (!response.ok) throw new Error(method + " " + path + " returned " + response.status);
    process.stdout.write(await response.text());
  ' -- "$@" < "$work/token"
}
cleanup() {
  if [[ -s "$work/token" ]]; then api POST /api/v1/auth/logout >/dev/null || true; fi
  "${kube[@]}" exec deployment/guild -c server -- rm -f "$fixture" >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT

"${kube[@]}" exec -i deployment/guild -c server -- bun run - > "$work/session" <<'JS'
import { createPlatformPool } from "./src/platform/db.ts";
import { IdentityStore } from "./src/platform/store/identity.ts";
const pool = createPlatformPool(process.env.GUILD_DATABASE_URL, 1);
try {
  const result = await pool.query(
    "SELECT id, org_id FROM users WHERE email = $1 AND role = $2", ["experiment@example.org", "admin"]);
  if (result.rows.length !== 1) throw new Error("experiment admin not found");
  const [user] = result.rows;
  const [, token] = await new IdentityStore(pool).createSession(user.id);
  process.stdout.write(JSON.stringify({ org: user.org_id, token }));
} finally {
  await pool.end();
}
JS
org=$(jq -re .org "$work/session")
jq -re .token "$work/session" > "$work/token"
"${kube[@]}" exec -i deployment/guild -c server -- sh -c 'cat > "$1"' sh "$fixture" < fixtures/verify-mcp-turn.mjs
"${kube[@]}" exec -i deployment/guild -c server -- env \
  PROBE_EXISTING_SESSION=1 PROBE_WORKSPACE=1 PROBE_REPORT_IDENTITY=1 bun "$fixture" < "$work/token" > "$work/turn"
ids="$(tail -n 1 "$work/turn")"
chat=$(jq -re .chatId <<< "$ids")
agent=$(jq -re .agentId <<< "$ids")
actor=$(printf 'agent:%s:%s' "$org" "$agent" | sha256sum | cut -c1-32)
actor="guild-$actor"
runtime_actor="guild-$(printf 'runtime:%s' "$chat" | sha256sum | cut -c1-32)"
actor_state() {
  "${ate[@]}" get actor "${1:-$actor}" -a guild-experiment -o json | jq -er '.status.state'
}
[[ "$(actor_state)" == ACTOR_STATE_RUNNING ]]
actors=$("${ate[@]}" get actors -a guild-experiment -o json)
jq -e --arg runtime "$runtime_actor" 'all(.actors[]; .metadata.name != $runtime)' <<< "$actors" >/dev/null
policy=$("${ate[@]}" get egress-policy "$actor" -a guild-experiment -o json)
jq -e 'all(.rules[]; (.tlsPassthrough.ports.numbers // [] | index(5432)) == null)' <<< "$policy" >/dev/null
"${kube[@]}" logs deployment/guild -c server |
  jq -R -e --arg chat "$chat" 'fromjson? | select(.chatId == $chat and .msg == "worker ready")' >/dev/null
printf '%s\n' 'The Guild pod ran the local worker and used a shell/file Actor with no PostgreSQL egress.'
previous_pod=$("${kube[@]}" get pod -l app=guild -o 'jsonpath={.items[0].metadata.uid}')
[[ -n "$previous_pod" ]]
"${kube[@]}" rollout restart deployment/guild
"${kube[@]}" rollout status deployment/guild --timeout=90s
current_pod=$("${kube[@]}" get pod -l app=guild -o 'jsonpath={.items[0].metadata.uid}')
[[ -n "$current_pod" && "$current_pod" != "$previous_pod" ]]
"${ate[@]}" suspend actor "$actor" -a guild-experiment >/dev/null
[[ "$(actor_state)" == ACTOR_STATE_SUSPENDED ]]
if [[ "$postgres_probe" == --postgres ]]; then
  guild_status() {
    "${kube[@]}" get pods -l app=guild -o json |
      jq -er '.items[] | select(.metadata.deletionTimestamp == null) |
        .metadata.uid as $uid | .status.containerStatuses[] | select(.name == "server") |
        [$uid, .restartCount] | @tsv'
  }
  guild_before_database_restart=$(guild_status)
  database_before=$("${kube[@]}" get pod postgres-0 -o 'jsonpath={.metadata.uid}')
  claim_before=$("${kube[@]}" get pvc data-postgres-0 -o 'jsonpath={.metadata.uid}')
  [[ -n "$database_before" && -n "$claim_before" ]]
  "${kube[@]}" rollout restart statefulset/postgres
  "${kube[@]}" rollout status statefulset/postgres --timeout=90s
  database_after=$("${kube[@]}" get pod postgres-0 -o 'jsonpath={.metadata.uid}')
  [[ -n "$database_after" && "$database_after" != "$database_before" ]]
  [[ "$("${kube[@]}" get pvc data-postgres-0 -o 'jsonpath={.metadata.uid}')" == "$claim_before" ]]
  printf '%s\n' 'PostgreSQL restarted on its existing persistent volume.'
fi
for attempt in {1..12}; do
  if api GET "/api/v1/chats/$chat/thread" > "$work/history"; then break; fi
  if (( attempt == 12 )); then exit 1; fi
  sleep 1
done
jq -e 'any(.events[].event; .type == "tool_result" and (tostring | contains("gateway-tool-result")))' "$work/history" >/dev/null
jq -e 'any(.events[].event; tostring | contains("verified-mcp-turn-finished"))' "$work/history" >/dev/null
[[ "$(api GET "/api/v1/agents/$agent/files/download?path=gateway-probe.txt")" == gateway-workspace-marker ]]
[[ "$(actor_state)" == ACTOR_STATE_SUSPENDED ]]
if [[ "$postgres_probe" == --postgres ]]; then
  [[ "$(guild_status)" == "$guild_before_database_restart" ]] || {
    printf '%s\n' 'The Guild server restarted during the PostgreSQL outage.' >&2
    exit 1
  }
fi
printf '%s\n' 'The MCP chat and workspace survived pod replacement while the Actor was suspended.'
