import assert from "node:assert/strict";
import { AgentGateway } from "./src/platform/agentgateway.ts";
import { mcpConnect } from "./src/integrations/mcp.ts";

const gateway = new AgentGateway({
  url: process.env.GUILD_AGENTGATEWAY_URL,
  issuer: process.env.GUILD_AGENTGATEWAY_ISSUER,
  signingKeyPath: process.env.GUILD_AGENTGATEWAY_SIGNING_KEY_FILE,
});
const org = "00000000-0000-4000-8000-000000000034";
const allowed = "00000000-0000-4000-8000-000000000035";
const denied = "00000000-0000-4000-8000-000000000036";
async function connect(member) {
  const { url, headers } = gateway.mcp(org, member);
  return mcpConnect(url, headers);
}
const client = await connect(allowed);
assert.deepEqual((await client.listTools()).map(({ name }) => name), ["registry_echo"]);
assert.deepEqual(await client.callTool("registry_echo", { text: "approved" }), {
  content: "hello:approved:", isError: false,
});
await assert.rejects(client.callTool("registry_search", { query: "denied" }));
const other = await connect(denied);
assert.deepEqual(await other.listTools(), []);
await assert.rejects(other.callTool("registry_echo", { text: "denied" }));
console.log("Approved registry bundle executed through MCP with member and tool policies");
