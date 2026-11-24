import assert from "node:assert/strict";

const base = "http://127.0.0.1:8080";
const credential = (await Bun.stdin.text()).trim();
const call = (path, method, token, body) => fetch(base + path, {
  method,
  headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(body ? { "content-type": "application/json" } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
let token = credential;
if (process.env.PROBE_EXISTING_SESSION !== "1") {
  const login = await call("/api/v1/auth/login", "POST", null, { email: "experiment@example.org", password: credential });
  assert.equal(login.status, 200);
  ({ token } = await login.json());
}

for (const [method, path] of [
  ["POST", "/api/v1/admin/integrations"],
  ["POST", "/api/v1/admin/integrations/mcp/probe"],
  ["POST", "/api/v1/admin/integrations/mcp"],
  ["POST", "/api/v1/admin/integrations/00000000-0000-4000-8000-000000000001/test"],
  ["POST", "/api/v1/admin/integrations/plugins/url"],
  ["POST", "/api/v1/registry/integration/fixture/install"],
  ["GET", "/api/v1/mcp/servers"],
  ["POST", "/api/v1/mcp/probe"],
  ["POST", "/api/v1/mcp/servers"],
]) {
  const response = await call(path, method, token, method === "GET" ? null : {});
  const text = await response.text();
  assert.equal(response.status, 409, `${method} ${path}: ${text}`);
  assert.match(text, /integration_managed_by_agentgateway/);
}
const tools = await call("/api/v1/integrations/fixture/tools", "GET", token, null);
assert.equal(tools.status, 200);
assert.deepEqual((await tools.json()).tools.map(({ name }) => name), ["fixture_echo_allowed"]);
const inventory = await call("/api/v1/admin/integrations", "GET", token, null);
assert.equal(inventory.status, 200);
const visible = await inventory.json();
assert.equal(visible.managedBy, "agentgateway");
assert.deepEqual(visible.items, []);
assert.deepEqual(visible.inventory.find(({ slug }) => slug === "fixture")?.tools, ["fixture_echo_allowed"]);
console.log("Guild exposes agentgateway inventory and rejects legacy integration management routes");
