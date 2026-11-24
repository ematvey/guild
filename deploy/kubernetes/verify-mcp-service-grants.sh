#!/usr/bin/env bash
set -euo pipefail
config="${1:?usage: verify-mcp-service-grants.sh KUBECONFIG}"
[[ "$(kubectl --kubeconfig "$config" config current-context)" == k3d-guild-agent-experiment ]]
cd "$(dirname "$0")/../.."
k=(kubectl --kubeconfig "$config" -n guild-experiment)
org=$(cat /proc/sys/kernel/random/uuid)
member=00000000-0000-4000-8000-000000000002
work=$(mktemp -d)
cleanup() {
  if [[ -s "$work/gateway.json" ]]; then "${k[@]}" delete --ignore-not-found -f "$work/gateway.json" >/dev/null; fi
  rm -rf "$work"
}
trap cleanup EXIT
jq -n --arg org "$org" --arg member "$member" '{
  org:$org, targets:[{
    name:"fixture",url:"http://guild-mcp-fixture.guild-experiment.svc.cluster.local:8080/mcp",
    credentialSecret:"guild-mcp-fixture-provider",members:[$member],tools:["echo_allowed","echo_denied"],services:[
      {id:"headless",tools:["echo_allowed"]},
      {id:"delegating",tools:["echo_allowed"],delegatedMembers:[$member]}
    ]
  }]
}' > "$work/inventory.json"
python3 deploy/kubernetes/render-org-mcp.py "$work/inventory.json" > "$work/gateway.json"
"${k[@]}" apply --server-side -f "$work/gateway.json" >/dev/null
"${k[@]}" wait --for=jsonpath='{.status.parents[0].conditions[?(@.type=="Accepted")].status}'=True "httproute/guild-mcp-$org" --timeout=60s
"${k[@]}" exec -i deploy/guild -c server -- env PROBE_ORG="$org" PROBE_MEMBER="$member" bun - <<'JS'
import assert from "node:assert/strict";
import {createPrivateKey,sign} from "node:crypto";
import {readFileSync} from "node:fs";
import {mcpConnect} from "./src/integrations/mcp.ts";
const org=process.env.PROBE_ORG;
const member=process.env.PROBE_MEMBER;
const url=process.env.GUILD_AGENTGATEWAY_URL+"/mcp/"+org;
const key=createPrivateKey(readFileSync(process.env.GUILD_AGENTGATEWAY_SIGNING_KEY_FILE));
const json=(value)=>Buffer.from(JSON.stringify(value)).toString("base64url");
const token=(claims)=>{
 const iat=Math.floor(Date.now()/1000);
 const data=json({typ:"JWT",alg:"RS256",kid:"guild-workload"})+"."+json({iss:process.env.GUILD_AGENTGATEWAY_ISSUER,aud:"guild-agentgateway",org,scope:"mcp",iat,exp:iat+60,...claims});
 return {authorization:"Bearer "+data+"."+sign("RSA-SHA256",Buffer.from(data),key).toString("base64url")};
};
async function list(claims) {
 const peer=await mcpConnect(url,token(claims));
 return [peer,(await peer.listTools()).map(({name})=>name).sort()];
}
let initial;
for(let retry=0;retry<25;retry++){
 try {initial=await list({sub:member}); if(initial[1].length===2) break;} catch (error) { if(retry===24) throw error; }
 await Bun.sleep(400);
}
assert.deepEqual(initial?.[1],["fixture_echo_allowed","fixture_echo_denied"]);
const [headless, allowed]=await list({sub:"service:headless"});
assert.deepEqual(allowed,["fixture_echo_allowed"]);
assert.deepEqual(await headless.callTool(allowed[0],{text:"shared service"}),{content:"shared service",isError:false});
await assert.rejects(headless.callTool("fixture_echo_denied",{text:"denied"}),/returned 400/);
assert.deepEqual((await list({sub:"service:unlisted"}))[1],[]);
assert.deepEqual((await list({sub:"service:delegating"}))[1],[]);
assert.deepEqual((await list({sub:"service:delegating",delegated_member:"00000000-0000-4000-8000-000000000003"}))[1],[]);
assert.deepEqual((await list({sub:"service:delegating",delegated_member:member}))[1],["fixture_echo_allowed"]);
console.log("Live MCP gateway approved member, service and delegated grants and rejected tools outside those grants");
JS
