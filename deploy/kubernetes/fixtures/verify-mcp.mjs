import assert from "node:assert/strict";
import { AgentGateway } from "./src/platform/agentgateway.ts";
import { mcpConnect } from "./src/integrations/mcp.ts";

const org = process.env.PROBE_ORG;
assert.match(org ?? "", /^[a-f0-9-]{36}$/);
const gateway = new AgentGateway({
  url: process.env.GUILD_AGENTGATEWAY_URL,
  issuer: process.env.GUILD_AGENTGATEWAY_ISSUER,
  signingKeyPath: process.env.GUILD_AGENTGATEWAY_SIGNING_KEY_FILE,
});
const member = "00000000-0000-4000-8000-000000000002";
const { url, headers } = gateway.mcp(org, member);
await assert.rejects(mcpConnect(url, {}), /returned 401/);
await assert.rejects(mcpConnect(url, gateway.mcp("00000000-0000-4000-8000-000000000001", member).headers), /returned 403/);
const peer = await mcpConnect(url, headers);
const tools = await peer.listTools();
const echo = tools.filter(({ name }) => name.startsWith("fixture_"));
assert.deepEqual(echo.map(({ name }) => name), ["fixture_echo_allowed"]);
assert.deepEqual(await peer.callTool(echo[0].name, { text: "fixture output" }), {
  content: "fixture output", isError: false,
});
await assert.rejects(
  peer.callTool(echo[0].name.replace(/echo_allowed$/, "echo_denied"), { text: "must be denied" }),
  /returned 400/,
);
if (process.env.PROBE_GOOGLE === "1") {
  const spoofed = await mcpConnect(url, { ...headers, "x-guild-mcp-caller-email": "experiment@example.org" });
  const rejected = await spoofed.callTool("google-workspace_drive_get_file", {
    file_id: "fixture-file", path: "must-not-exist.bin",
  });
  assert.equal(rejected.isError, true, JSON.stringify(rejected));
  assert.match(rejected.content, /delegated member identity is required/);
}
console.log("MCP: authorized inventory and tool call passed, wrong org and denied tool rejected");
