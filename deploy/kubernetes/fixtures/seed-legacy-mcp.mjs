import { loadConfig } from "./src/config.ts";
import { masterKeyBytes } from "./src/platform/crypto.ts";
import { createPlatformPool } from "./src/platform/db.ts";
import { IntegrationSecretStore, IntegrationStore } from "./src/platform/store/integrations.ts";
import { UserMcpStore } from "./src/platform/store/user-mcp.ts";
import { builtinMcpByName } from "./src/integrations/loader.ts";

const org = "00000000-0000-4000-8000-000000000024";
const owner = "00000000-0000-4000-8000-000000000025";
const other = "00000000-0000-4000-8000-000000000026";
const config = loadConfig();
const pool = createPlatformPool(config.databaseUrl, 1);
try {
  await pool.query("INSERT INTO orgs (id, name) VALUES ($1, 'MCP migration fixture') ON CONFLICT DO NOTHING", [org]);
  for (const [id, email] of [[owner, "migration-owner@example.org"], [other, "migration-other@example.org"]]) {
    await pool.query(
      "INSERT INTO users (id, org_id, email, role, password_hash) VALUES ($1, $2, $3, 'member', 'unused') ON CONFLICT DO NOTHING",
      [id, org, email],
    );
  }
  const key = masterKeyBytes(config.masterKeyHex);
  const users = new UserMcpStore(pool);
  const integrations = new IntegrationStore(pool);
  const secrets = new IntegrationSecretStore(pool);
  const base = "http://guild-mcp-fixture.guild-experiment.svc.cluster.local:8080";
  const personal = (await users.list(org, owner)).find(({ name }) => name === "migration-private") ??
    await users.create(org, owner, "migration-private", base + "/mcp", { "x-fixture-mcp-token": "fixture-private-token" }, true, key);
  const shared = await integrations.upsert(org, "migration-remote", {
    mcp: { url: base + "/mcp", envelope: false, headers: { Authorization: "Bearer {authorization}" } },
  }, true);
  await secrets.upsert(org, "migration-remote", "authorization", "fixture-mcp-key", key);
  const envelope = await integrations.upsert(org, "migration-envelope", { mcp: { url: base + "/envelope" } }, true);
  await secrets.upsert(org, "migration-envelope", "token", "fixture-envelope-key", key);
  const stripeMcp = builtinMcpByName("stripe").manifest.mcp;
  const stripe = await integrations.upsert(org, "stripe", { mcp: { ...stripeMcp, url: base + "/stripe-mcp" } }, true);
  await secrets.upsert(org, "stripe", "stripe_key", "fixture-stripe-key", key);
  await secrets.upsert(org, "stripe", "stripe_account", "acct_fixture", key);
  const searx = await integrations.upsert(org, "searxng", { base_url: base }, true);
  process.stdout.write(JSON.stringify({ org, targets: [
    { name: "migration-private", source: "personal", id: personal.id, owner, tools: ["echo_allowed"] },
    { name: "migration-remote", source: "org", id: shared, members: [owner, other], tools: ["echo_allowed"] },
    { name: "migration-envelope", source: "org", id: envelope, members: [owner], tools: ["echo_allowed"], identityEnvelope: true },
    { name: "stripe", source: "org", id: stripe, members: [owner], tools: ["echo_allowed"],
      chats: ["00000000-0000-4000-8000-000000000027"] },
    { name: "searxng", source: "org", id: searx, members: [owner, other], tools: ["web_search"] },
  ] }) + "\n");
} finally {
  await pool.end();
}
