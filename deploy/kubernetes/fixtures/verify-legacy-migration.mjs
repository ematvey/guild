import assert from "node:assert/strict";
import { AgentGateway } from "./src/platform/agentgateway.ts";
import { mcpConnect } from "./src/integrations/mcp.ts";

const org = "00000000-0000-4000-8000-000000000024";
const gateway = new AgentGateway({
  url: process.env.GUILD_AGENTGATEWAY_URL,
  issuer: process.env.GUILD_AGENTGATEWAY_ISSUER,
  signingKeyPath: process.env.GUILD_AGENTGATEWAY_SIGNING_KEY_FILE,
});
async function peer(member, actingAs, chat) {
  const { url, headers } = gateway.mcp(org, member, actingAs, chat);
  return mcpConnect(url, { ...headers, "x-guild-caller": "spoofed" });
}
const ownerId = "00000000-0000-4000-8000-000000000025";
const owner = await peer(ownerId);
const other = await peer("00000000-0000-4000-8000-000000000026");
assert.deepEqual((await owner.listTools()).map(({ name }) => name).sort(), [
  "migration-envelope_echo_allowed", "migration-private_echo_allowed", "migration-remote_echo_allowed", "searxng_web_search",
]);
assert.deepEqual((await other.listTools()).map(({ name }) => name).sort(), [
  "migration-remote_echo_allowed", "searxng_web_search",
]);
assert.equal((await owner.callTool("migration-private_echo_allowed", { text: "private credential worked" })).content, "private credential worked");
const actingOwner = await peer(ownerId, "migration-owner@example.org");
assert.equal((await actingOwner.callTool("migration-envelope_echo_allowed", { text: "legacy identity worked" })).content, "legacy identity worked");
assert.equal((await other.callTool("migration-remote_echo_allowed", { text: "org credential worked" })).content, "org credential worked");
await assert.rejects(owner.callTool("stripe_echo_allowed", { text: "missing chat claim" }));
const stripeChat = await peer(ownerId, undefined, "00000000-0000-4000-8000-000000000027");
assert.ok((await stripeChat.listTools()).some(({ name }) => name === "stripe_echo_allowed"));
assert.equal((await stripeChat.callTool("stripe_echo_allowed", { text: "connected account credential worked" })).content,
  "connected account credential worked");
assert.match((await other.callTool("searxng_web_search", { query: "migrated connector" })).content, /query: migrated connector/);
await assert.rejects(other.callTool("migration-private_echo_allowed", { text: "must be denied" }));
await assert.rejects(other.callTool("migration-envelope_echo_allowed", { text: "must be denied" }));
await assert.rejects(other.callTool("stripe_echo_allowed", { text: "must be denied" }));
console.log("Migrated encrypted credentials, Stripe account scoping, the signed legacy identity envelope, and a compiled connector");
