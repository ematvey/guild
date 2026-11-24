import assert from "node:assert/strict";
import { AgentGateway } from "./src/platform/agentgateway.ts";
import { mcpConnect } from "./src/integrations/mcp.ts";

const gateway = new AgentGateway({
  url: process.env.GUILD_AGENTGATEWAY_URL,
  issuer: process.env.GUILD_AGENTGATEWAY_ISSUER,
  signingKeyPath: process.env.GUILD_AGENTGATEWAY_SIGNING_KEY_FILE,
});
const org = process.env.PROBE_ORG ?? "00000000-0000-4000-8000-000000000014";
const owner = "00000000-0000-4000-8000-000000000015";
const other = "00000000-0000-4000-8000-000000000016";
const chat = process.env.PROBE_CHAT;

async function connect(member, chatId) {
  const { url, headers } = gateway.mcp(org, member, undefined, chatId);
  return mcpConnect(url, headers);
}
const authorized = await connect(owner, chat);
assert.deepEqual((await authorized.listTools()).map(({ name }) => name).sort(), ["personal_echo_allowed", "shared_echo_allowed"]);
assert.deepEqual(await authorized.callTool("personal_echo_allowed", { text: "personal scope" }), {
  content: "personal scope", isError: false,
});
const unauthorized = await connect(other, chat);
assert.deepEqual((await unauthorized.listTools()).map(({ name }) => name), ["shared_echo_allowed"]);
await assert.rejects(unauthorized.callTool("personal_echo_allowed", { text: "must be denied" }));
console.log("Agentgateway isolated a member-specific MCP target from another member in the same org");
if (chat) {
  for (const requestedChat of [undefined, "00000000-0000-4000-8000-000000000018"]) {
    const wrongContext = await connect(owner, requestedChat);
    assert.deepEqual((await wrongContext.listTools()).map(({ name }) => name), ["shared_echo_allowed"]);
    await assert.rejects(wrongContext.callTool("personal_echo_allowed", { text: "wrong chat" }));
  }
  console.log("The allowed member could discover and call the private tool from the permitted chat only");
}

if (process.env.PROBE_POLICY_RELOAD === "1") {
  console.log("Waiting for gateway policy revocation");
  for (let attempt = 0; ; attempt++) {
    try {
      const visible = (await authorized.listTools()).map(({ name }) => name);
      if (visible.length === 1 && visible[0] === "shared_echo_allowed") break;
    } catch (error) {
      if (!String(error).includes("server returned 404")) throw error;
      break;
    }
    assert.ok(attempt < 30, "gateway continued advertising a revoked tool");
    await Bun.sleep(1000);
  }
  await assert.rejects(authorized.callTool("personal_echo_allowed", { text: "revoked" }));
  const fresh = await connect(owner, chat);
  assert.deepEqual((await fresh.listTools()).map(({ name }) => name), ["shared_echo_allowed"]);
  await assert.rejects(fresh.callTool("personal_echo_allowed", { text: "still revoked" }));
  assert.deepEqual(await fresh.callTool("shared_echo_allowed", { text: "still permitted" }), {
    content: "still permitted", isError: false,
  });
  console.log("Agentgateway revoked the personal tool on the old connection and preserved shared access on a fresh connection");
}
