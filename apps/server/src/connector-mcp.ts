import { createPublicKey, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { relativeDestination } from "./platform/domain/paths.js";
import { loadCodePlugin } from "./integrations/code-plugins.js";
import { delegatedIdentity } from "./integrations/connector-mcp-identity.js";
import { builtinByName } from "./integrations/loader.js";
import sharedVendors from "./integrations/shared-mcp-vendors.json" with { type: "json" };
import { callSignals, type JsonObject } from "./integrations/shared.js";

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  return value as JsonObject;
}

const slug = process.env.GUILD_MCP_CONNECTOR ?? "";
const bundleHash = process.env.GUILD_MCP_BUNDLE_SHA256;
const bundleVersion = process.env.GUILD_MCP_BUNDLE_VERSION;
if (bundleHash !== undefined && (!/^[a-f0-9]{64}$/.test(bundleHash) || !bundleVersion)) {
  throw new Error("a registry connector needs an approved bundle hash and version");
}
const connector = bundleHash === undefined
  ? builtinByName(slug)
  : await loadCodePlugin(() => readFile("/opt/guild-mcp-bundle.tar.gz"), bundleHash, slug, bundleVersion!);
if (!connector) throw new Error(`unknown MCP connector ${slug}`);
const settingsPath = process.env.GUILD_MCP_SETTINGS_FILE ?? "/run/guild-mcp/settings.json";
const keyPath = process.env.GUILD_MCP_KEY_FILE ?? "/run/guild-mcp/access-key";
const shared = process.env.GUILD_MCP_SHARED === "1";
const sharedVendor = shared && Object.hasOwn(sharedVendors, slug) && bundleHash === undefined
  ? sharedVendors[slug as keyof typeof sharedVendors]
  : null;
if (shared && !sharedVendor) throw new Error("connector does not support shared MCP placement");
const settings = sharedVendor
  ? { config: { [sharedVendor.urlKey]: sharedVendor.url }, secrets: {} }
  : object(JSON.parse(await readFile(settingsPath, "utf8")));
const config = object(settings["config"] ?? {});
const secrets = Object.entries(object(settings["secrets"] ?? {})).map(([name, value]): [string, string] => {
  if (typeof value !== "string") throw new Error(`invalid connector secret ${name}`);
  return [name, value];
});
const impersonated = connector.auth_kind === "org_secret_impersonated";
const issuer = process.env.GUILD_MCP_ISSUER ?? "";
const orgId = process.env.GUILD_MCP_ORG ?? "";
const publicKey = impersonated ? createPublicKey(await readFile("/run/guild-mcp/issuer.pem")) : null;
if (publicKey && (!issuer || !orgId || publicKey.asymmetricKeyType !== "rsa")) {
  throw new Error("missing or invalid MCP delegated identity configuration");
}
const secretKey = impersonated ? null : (await readFile(keyPath, "utf8")).trim();
if (secretKey !== null && secretKey.length < 24) throw new Error("MCP upstream access key is too short");
const expected = secretKey === null ? null : Buffer.from(`Bearer ${secretKey}`);
const tools = (await connector.toolSpecs(config)).map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.parameters,
  annotations: { readOnlyHint: connector.classes[tool.name] === "read" },
}));
const byName = new Set(tools.map((tool) => tool.name));
const app = Fastify({ bodyLimit: 4 * 1024 * 1024 });
app.get("/healthz", async () => ({ ok: true }));
app.post("/mcp", async (req, reply) => {
  const authorization = req.headers.authorization ?? "";
  const acting = publicKey ? delegatedIdentity(authorization, publicKey, issuer, orgId) : null;
  const supplied = Buffer.from(authorization);
  if (expected === null
    ? acting === null
    : supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return reply.code(401).send();
  }
  let message: JsonObject;
  try { message = object(req.body); } catch { return reply.code(400).send(); }
  if (message["jsonrpc"] !== "2.0" || typeof message["method"] !== "string") return reply.code(400).send();

  const id = message["id"];
  if (id === undefined) return reply.code(202).send();
  if (typeof id !== "string" && typeof id !== "number") return reply.code(400).send();
  const result = (data: JsonObject) => ({ jsonrpc: "2.0", id, result: data });
  const failure = (code: number, text: string) => ({ jsonrpc: "2.0", id, error: { code, message: text } });

  switch (message["method"]) {
    case "initialize":
      return result({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: slug, version: connector.version } });
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools });
    case "tools/call": {
      let params: JsonObject;
      let args: JsonObject;
      try {
        params = object(message["params"]);
        args = object(params["arguments"] ?? {});
      } catch {
        return failure(-32602, "invalid tool arguments");
      }
      const name = params["name"];
      if (typeof name !== "string" || !byName.has(name)) return failure(-32602, "unknown tool");
      const signal = AbortSignal.timeout(55_000);
      const caller = acting?.actingAs ?? null;
      if (impersonated && caller === null) {
        return result({ isError: true, content: [{ type: "text", text: "a delegated member identity is required" }] });
      }
      let callSecrets = secrets;
      if (sharedVendor) {
        const token = req.headers["x-guild-mcp-connector-token"];
        if (typeof token !== "string" || token.length === 0 || token.length > 2048) {
          return failure(-32603, "missing connector target credential");
        }
        callSecrets = [[sharedVendor.secretKey, token]];
      }
      try {
        const outcome = await callSignals.run(signal, () =>
          connector.execute(config, name, args, callSecrets, caller));
        const structuredContent: JsonObject = {};
        if (outcome.meta !== undefined) structuredContent["guildMeta"] = outcome.meta;
        if (outcome.file !== undefined) {
          const destination = relativeDestination(outcome.file.path);
          if (!destination.ok || outcome.file.bytes.length > 36 * 1024 * 1024) {
            return result({ isError: true, content: [{ type: "text", text: "invalid or oversized file result" }] });
          }
          structuredContent["guildFile"] = { path: destination.path, base64: outcome.file.bytes.toString("base64") };
        }
        return result({
          content: [{ type: "text", text: outcome.content }],
          ...(Object.keys(structuredContent).length === 0 ? {} : { structuredContent }),
        });
      } catch {
        return result({ isError: true, content: [{ type: "text", text: "the integration request failed" }] });
      }
    }
    default:
      return failure(-32601, "method not found");
  }
});

await app.listen({ host: "0.0.0.0", port: 8080 });
