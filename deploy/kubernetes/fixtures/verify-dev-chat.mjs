import assert from "node:assert/strict";
import {createPlatformPool} from "./src/platform/db.ts";
import {IdentityStore} from "./src/platform/store/identity.ts";
const origin = new URL(process.env.PROBE_GUILD_ORIGIN);
assert.equal(origin.protocol, "https:");
assert.equal(origin.origin, new URL(process.env.GUILD_API_URL).origin, "probe origin must match the deployed Guild origin");
const db=createPlatformPool(process.env.GUILD_DATABASE_URL,1);
const identity=new IdentityStore(db);
let token, chat;
async function api(path, method="GET", body) {
  const result=await fetch(new URL(path, origin),{
    method, headers:{authorization:"Bearer "+token,...(body ? {"content-type":"application/json"} : {})},
    ...(body ? {body:JSON.stringify(body)} : {}),
    signal:AbortSignal.timeout(60000),
  });
  assert.ok(result.ok, method+" "+path+" HTTP "+result.status);
  const text=await result.text(); return text ? JSON.parse(text) : null;
}
try {
  const {rows:[user]}=await db.query("SELECT u.id FROM users u WHERE EXISTS (SELECT 1 FROM agents a WHERE a.org_id=u.org_id AND a.is_personal) ORDER BY (u.role = 'admin') DESC, u.created_at LIMIT 1");
  assert.ok(user,"no dev user is available");
  [,token]=await identity.createSession(user.id);
  const {models}=await api("/api/v1/models");
  assert.ok(models.length,"no dev models configured");
  const { items } = await api("/api/v1/admin/integrations");
  assert.ok(items.some((item) => item.name === "github"), "Guild's GitHub integration settings are missing");
  const { tools } = await api("/api/v1/integrations/github/tools");
  assert.ok(tools.some((tool) => tool.name === "github_search_repositories"), "GitHub search is unavailable");
  const read = await api("/api/v1/integrations/github/tools/search_repositories", "POST", {
    query: "repo:octocat/Hello-World", per_page: 1,
  });
  assert.equal(read.ok, true, "GitHub integration read failed");
  console.log("Public Guild integration inventory and GitHub integration read passed");
  ({id:chat}=await api("/api/v1/chats","POST",{title:"Temporary deployment smoke"}));
  const messageId=crypto.randomUUID();
  const ack=await api("/api/v1/threads/"+chat+"/turns","POST",{
    model:models[0], user_message_id:messageId, messages:[{role:"user",content:"Reply with OK only."}],
  });
  assert.equal(ack.user_message_id,messageId);
  console.log("Public Assistant send returned HTTP 200 and acknowledged its message ID");
  for(let n=0;n<60;n++){
    const {events}=await api("/api/v1/chats/"+chat+"/thread");
    if(events.some(({event})=>event.type==="assistant_message")){
      console.log("Public thread returned the persisted Assistant reply");
      break;
    }
    if(n===59) throw new Error("No Assistant reply was persisted within 60 seconds");
    await Bun.sleep(1000);
  }
} finally {
  if(chat) await api("/api/v1/chats/"+chat,"DELETE").catch(()=>{ console.log("Temporary chat cleanup failed"); });
  if(token) await identity.revokeSession(token);
  await db.end();
}
