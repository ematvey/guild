import assert from "node:assert/strict";
import { AgentGateway } from "./src/platform/agentgateway.ts";

const org = process.env.PROBE_ORG;
assert.match(org ?? "", /^[a-f0-9-]{36}$/);
const newGateway = () => new AgentGateway({
  url: process.env.GUILD_AGENTGATEWAY_URL,
  issuer: process.env.GUILD_AGENTGATEWAY_ISSUER,
  signingKeyPath: process.env.GUILD_AGENTGATEWAY_SIGNING_KEY_FILE,
});
const gateway = newGateway();
for (const [protocol, path] of [
  ["openai", "/v1/chat/completions"],
  ["anthropic", "/v1/messages"],
]) {
  const model = `fixture-${protocol}`;
  const payload = JSON.stringify({
    model, messages: [{ role: "user", content: "probe" }], max_tokens: 128, stream: true,
  });
  const { baseUrl } = gateway.model(org, model, protocol);
  const wrongOrg = gateway.model("00000000-0000-4000-8000-000000000001", model, protocol).authorization;
  const wrongModel = gateway.model(org, model + "-denied", protocol).authorization;
  for (const [authorization, expected] of [[null, 401], [wrongOrg, 403], [wrongModel, 403]]) {
    const rejected = await fetch(baseUrl + path, {
      method: "POST", body: payload, headers: {
        "content-type": "application/json", ...(authorization ? { authorization } : {}),
      },
    });
    assert.equal(rejected.status, expected, await rejected.text());
  }
  const response = await fetch(`http://127.0.0.1:8080/${protocol}${path}`, {
    method: "POST", body: payload, headers: {
      "content-type": "application/json", "x-guild-org-id": org,
      authorization: `Bearer ${process.env.GUILD_INTERNAL_KEY}`,
      ...(protocol === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
    },
  });
  const stream = await response.text();
  assert.equal(response.status, 200, stream);
  assert.match(stream, /guild-agentgateway-probe/);
  assert.match(stream, protocol === "openai" ? /\[DONE\]/ : /message_stop/);
  console.log(`${protocol}: rejected missing and mismatched claims, streamed through Guild`);
}
