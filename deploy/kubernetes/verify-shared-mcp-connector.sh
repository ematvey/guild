#!/usr/bin/env bash
set -euo pipefail
config="${1:?usage: verify-shared-mcp-connector.sh KUBECONFIG [VENDOR] [--default-dev]}"
vendor="${2:-github}"
context="$(kubectl --kubeconfig "$config" config current-context)"
[[ "$context" == k3d-guild-agent-experiment || ( "$context" == default && "${3:-}" == --default-dev ) ]]
cd "$(dirname "$0")/../.."
k=(kubectl --kubeconfig "$config" -n guild-experiment)
case "$vendor" in github|slack|hubspot) ;; *) exit 2 ;; esac
name="guild-mcp-$vendor"
image="guild-k8s-server:experiment"
if [[ "$context" == default ]]; then
  image=$("${k[@]}" get deployment guild -o jsonpath='{.spec.template.spec.containers[?(@.name=="server")].image}')
  [[ -n "$image" ]]
fi
[[ -z "$("${k[@]}" get deploy "$name" --ignore-not-found -o name)" ]]
[[ -z "$("${k[@]}" get secret "$name-access" --ignore-not-found -o name)" ]]
org_a=$(cat /proc/sys/kernel/random/uuid)
org_b=$(cat /proc/sys/kernel/random/uuid)
work=$(mktemp -d)
cleanup() {
 for doc in "$work/a.json" "$work/b.json" "$work/connector.json"; do
   if [[ -s "$doc" ]]; then "${k[@]}" delete --ignore-not-found -f "$doc" >/dev/null; fi
 done
 "${k[@]}" delete --ignore-not-found secret "$name-access" "$name-smoke-a" "$name-smoke-b" >/dev/null
 "${k[@]}" delete --ignore-not-found configmap "$name-smoke" >/dev/null
 rm -rf "$work"
}
trap cleanup EXIT
cat > "$work/preload.mjs" <<'JS'
const original=globalThis.fetch;
globalThis.fetch=(input,init)=>{
 const url=new URL(typeof input==="string" ? input : input instanceof URL ? input : input.url);
 if(!["api.github.com","slack.com","api.hubapi.com"].includes(url.hostname)) return original(input,init);
 const token=new Headers(init?.headers).get("authorization");
 const tenant=token==="Bearer fixture-target-a" ? "tenant-a" : token==="Bearer fixture-target-b" ? "tenant-b" : null;
 if(!tenant) return Promise.resolve(new Response(null,{status:401}));
 const result=url.hostname==="api.github.com"
   ? {total_count:1,items:[{full_name:"fixture/"+tenant}]}
   : url.hostname==="slack.com"
     ? {ok:true,channels:[{id:tenant,name:tenant}]}
     : {total:1,results:[{id:tenant,properties:{email:tenant+"@example.org"}}]};
 return Promise.resolve(Response.json(result));
};
JS
"${k[@]}" create configmap "$name-smoke" --from-file=connector-mcp.ts=apps/server/src/connector-mcp.ts --from-file=apps/server/src/integrations/shared-mcp-vendors.json --from-file="$work/preload.mjs" >/dev/null
"${k[@]}" create secret generic "$name-access" --from-literal=Authorization=fixture-shared-gateway-access-secret >/dev/null
"${k[@]}" create secret generic "$name-smoke-a" --from-literal=token=fixture-target-a >/dev/null
"${k[@]}" create secret generic "$name-smoke-b" --from-literal=token=fixture-target-b >/dev/null
python3 deploy/kubernetes/render-connector.py "$vendor" --shared --image "$image" | jq --arg name "$name-smoke" '
(.items[]|select(.kind=="Deployment")|.spec.template.spec) |=
  (.volumes += [{name:"fixture",configMap:{name:$name}}] |
   .containers[0].command=["bun","--preload","/fixture/preload.mjs","src/connector-mcp.ts"] |
   .containers[0].volumeMounts += [
     {name:"fixture",mountPath:"/fixture",readOnly:true},
     {name:"fixture",mountPath:"/app/apps/server/src/connector-mcp.ts",subPath:"connector-mcp.ts",readOnly:true},
     {name:"fixture",mountPath:"/app/apps/server/src/integrations/shared-mcp-vendors.json",subPath:"shared-mcp-vendors.json",readOnly:true}
   ])' > "$work/connector.json"
"${k[@]}" apply --server-side -f "$work/connector.json" >/dev/null
"${k[@]}" rollout status "deploy/$name" --timeout=90s
case "$vendor" in
 github) tool=search_repositories ;;
 slack) tool=conversations_list ;;
 hubspot) tool=search_contacts ;;
esac
for target in a b; do
 org=$org_a
 [[ "$target" == a ]] || org=$org_b
 jq -n --arg org "$org" --arg credential "$name-smoke-$target" --arg vendor "$vendor" --arg tool "$tool" '{org:$org,targets:[{
   name:$vendor,url:("http://guild-mcp-"+$vendor+".guild-experiment.svc.cluster.local:8080/mcp"),
   tools:[$tool],sharedConnector:$vendor,sharedCredential:$credential
 }]}' > "$work/input.json"
 python3 deploy/kubernetes/render-org-mcp.py "$work/input.json" > "$work/$target.json"
 "${k[@]}" apply --server-side -f "$work/$target.json" >/dev/null
 "${k[@]}" wait --for=jsonpath='{.status.parents[0].conditions[?(@.type=="Accepted")].status}'=True "httproute/guild-mcp-$org" --timeout=60s
done
"${k[@]}" exec -i deploy/guild -c server -- env ORG_A="$org_a" ORG_B="$org_b" VENDOR="$vendor" TOOL="$tool" bun - <<'JS'
import assert from "node:assert/strict";
import { AgentGateway } from "./src/platform/agentgateway.ts";
import { mcpConnect } from "./src/integrations/mcp.ts";
const gateway=new AgentGateway({
  url:process.env.GUILD_AGENTGATEWAY_URL, issuer:process.env.GUILD_AGENTGATEWAY_ISSUER,
  signingKeyPath:process.env.GUILD_AGENTGATEWAY_SIGNING_KEY_FILE,
});
async function test(org, tenant, spoof) {
 const {url,headers}=gateway.mcp(org,"00000000-0000-4000-8000-000000000002");
 const peer=await mcpConnect(url,{...headers,"x-guild-mcp-connector-token":spoof});
 const tools=await peer.listTools();
 assert.deepEqual(tools.map(({name})=>name),[process.env.VENDOR+"_"+process.env.TOOL]);
 const result=await peer.callTool(tools[0].name,{query:"guild"});
 assert.equal(result.isError,false,JSON.stringify(result));
 assert.match(result.content,new RegExp("tenant-"+tenant));
}
for(let attempt=0;;attempt++){
 try {
  await Promise.all([test(process.env.ORG_A,"a","fixture-target-b"),test(process.env.ORG_B,"b","fixture-target-a")]);
  break;
 } catch(error) {
  if(attempt===10) throw error;
  await Bun.sleep(400);
 }
}
console.log("One "+process.env.VENDOR+" connector handled both orgs with distinct injected credentials and rejected caller header overrides");
JS
