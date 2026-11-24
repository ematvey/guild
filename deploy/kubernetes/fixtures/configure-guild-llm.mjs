import assert from "node:assert/strict";

const password = (await Bun.stdin.text()).trim();
assert.ok(password.length >= 24);
const credentials = { email: "experiment@example.org", password };
const base = "http://127.0.0.1:8080";
async function send(path, method, body, token) {
  return fetch(base + path, {
    method, body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
}
const bootstrap = await send("/api/v1/auth/bootstrap", "POST", credentials);
assert.ok(bootstrap.ok || bootstrap.status === 409, await bootstrap.text());
const login = await send("/api/v1/auth/login", "POST", credentials);
assert.equal(login.status, 200);
const { token, user } = await login.json();

for (const protocol of ["openai", "anthropic"]) {
  const model = `fixture-${protocol}`;
  const provider = await send("/api/v1/admin/gateway/providers", "POST", {
    name: model, protocol, base_url: "http://unused.example.org", key: "unused-fixture",
  }, token);
  assert.ok(provider.ok || provider.status === 409, await provider.text());
  const route = await send("/api/v1/admin/gateway/routes", "PUT", {
    model, provider: model, price_in: 0, price_out: 0, max_output_tokens: 128,
  }, token);
  assert.ok(route.ok, await route.text());
}
process.stdout.write(user.org_id + "\n");
