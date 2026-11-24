import assert from "node:assert/strict";

const credential = (await Bun.stdin.text()).trim();
const base = "http://127.0.0.1:8080";
const workspace = process.env.PROBE_WORKSPACE === "1";
const google = process.env.PROBE_GOOGLE === "1";
const email = "experiment@example.org";
async function request(path, { method = "GET", token, body } = {}) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const content = await response.text();
  assert.equal(response.status, 200, `${method} ${path}: ${content}`);
  return JSON.parse(content);
}

const token = process.env.PROBE_EXISTING_SESSION === "1" ? credential
  : (await request("/api/v1/auth/login", { method: "POST", body: { email, password: credential } })).token;
const inventory = await request("/api/v1/integrations/fixture/tools", { token });
assert.deepEqual(inventory.tools.map(({ name }) => name), ["fixture_echo_allowed"]);
const tool = await request("/api/v1/integrations/fixture/tools/echo_allowed", {
  method: "POST", token, body: { text: "direct-probe" },
});
assert.equal(tool.ok, true, JSON.stringify(tool));
assert.equal(tool.content, "direct-probe");
const { agent } = await request("/api/v1/agents", {
  method: "POST", token, body: {
    name: `MCP probe ${crypto.randomUUID().slice(0, 8)}`,
    model: "fixture-openai", visibility: "private", tools_mode: "all",
  },
});
const { id } = await request("/api/v1/chats", { method: "POST", token, body: { title: "MCP experiment probe" } });
if (workspace || google) {
  await request(`/api/v1/threads/${id}/approval`, { method: "POST", token, body: { default: "full_access" } });
}
await request(`/api/v1/threads/${id}/turns`, {
  method: "POST", token, body: {
    agent_id: agent.id, model: "fixture-openai", messages: [{ role: "user", content: "guild-experiment-mcp-turn" + (workspace ? " with-workspace" : "") + (google ? " with-google" : "") }],
  },
});

let events;
for (let i = 0; i < 60; i++) {
  ({ events } = await request(`/api/v1/chats/${id}/thread`, { token }));
  if (JSON.stringify(events).includes("verified-mcp-turn-finished")) break;
  await Bun.sleep(500);
}
const markers = JSON.stringify(events);
assert.match(markers, /verified-mcp-turn-finished/);
assert.ok(events.some(({ event }) => event.type === "tool_result" && JSON.stringify(event).includes("gateway-tool-result")));
if (process.env.PROBE_SEARXNG === "1") {
  const search = await request("/api/v1/integrations/searxng/tools/web_search", {
    method: "POST", token, body: { query: "gateway connector probe" },
  });
  assert.equal(search.ok, true, JSON.stringify(search));
  assert.match(search.content, /query: gateway connector probe/);
  assert.equal(search.meta.card, "web");
  console.log("SearXNG connector ran behind agentgateway MCP and preserved its result metadata");
}
if (workspace) {
  const response = await fetch(base + `/api/v1/agents/${agent.id}/files/download?path=gateway-probe.txt`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "gateway-workspace-marker");
  console.log("Guild chat wrote and read a Substrate workspace file and downloaded it through Guild");
}
if (google) {
  const response = await fetch(base + `/api/v1/agents/${agent.id}/files/download?path=gateway-probe.bin`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(Array.from(new Uint8Array(await response.arrayBuffer())), [0, 255, 71, 85, 73, 76, 68]);
  console.log("Google connector received the delegated member identity and wrote exact binary bytes to JuiceFS");
}
console.log("Guild chat discovered and executed the authorized MCP tool through agentgateway");
if (process.env.PROBE_REPORT_IDENTITY === "1") {
  console.log(JSON.stringify({ chatId: id, agentId: agent.id }));
}
