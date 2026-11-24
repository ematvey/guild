// Operator export of selected legacy connections. Output contains Kubernetes
// Secrets and must go directly to a private file or a Secret consumer.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadConfig } from "../config.js";
import { masterKeyBytes } from "../platform/crypto.js";
import { createPlatformPool } from "../platform/db.js";
import { IntegrationSecretStore, IntegrationStore } from "../platform/store/integrations.js";
import { UserMcpStore } from "../platform/store/user-mcp.js";
import { builtinByName } from "./loader.js";
import { mcpRequestHeaders } from "./mcp-headers.js";
import sharedVendors from "./shared-mcp-vendors.json" with { type: "json" };
import type { JsonObject } from "./shared.js";

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const toolName = /^[A-Za-z0-9_-]+$/;
const namespace = "guild-experiment";

interface Selection {
  name: string;
  source: "personal" | "org";
  id: string;
  owner?: string;
  members?: string[];
  memberTools?: Record<string, string[]>;
  chats?: string[];
  tools: string[];
  identityEnvelope?: boolean;
  placement?: "shared" | "tenant";
  services?: { id: string; tools: string[]; delegatedMembers?: string[] }[];
}

function object(value: unknown): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
  return value as JsonObject;
}

function secret(name: string, entries: Record<string, string>) {
  return {
    apiVersion: "v1", kind: "Secret", metadata: { name, namespace }, type: "Opaque",
    data: Object.fromEntries(Object.entries(entries).map(([key, value]) => [key, Buffer.from(value).toString("base64")])),
  };
}

async function run() {
  if (process.stdout.isTTY) throw new Error("redirect this credential export to a private file");
  const planPath = process.argv[2];
  if (!planPath) throw new Error("provide the explicit MCP migration plan");
  const plan = object(JSON.parse(await readFile(planPath, "utf8")));
  const org = plan["org"];
  const selected = plan["targets"] as Selection[];
  if (typeof org !== "string" || !uuid.test(org) || !Array.isArray(selected) || selected.length === 0) {
    throw new Error("the plan needs an org UUID and at least one selected target");
  }
  const config = loadConfig();
  const pool = createPlatformPool(config.databaseUrl, 1);
  const key = masterKeyBytes(config.masterKeyHex);
  const users = new UserMcpStore(pool);
  const orgs = new IntegrationStore(pool);
  const integrationSecrets = new IntegrationSecretStore(pool);
  const targets: JsonObject[] = [];
  const secrets: ReturnType<typeof secret>[] = [];
  const connectors = new Set<string>();
  const sharedConnectors = new Set<string>();
  const legacyProxies = new Set<string>();
  const names = new Set<string>();
  try {
    for (const selection of selected) {
      const { name, id, tools } = selection;
      if (!dnsLabel.test(name) || names.has(name) || !uuid.test(id) ||
          !Array.isArray(tools) || tools.length === 0 || !tools.every((tool) => typeof tool === "string" && toolName.test(tool))) {
        throw new Error("each target needs a unique DNS label, source UUID and explicit tool allowlist");
      }
      names.add(name);
      if (selection.placement !== undefined && selection.placement !== "shared" && selection.placement !== "tenant") {
        throw new Error(`${name}: invalid connector placement`);
      }
      if (selection.placement === "shared" && selection.source !== "org") {
        throw new Error(`${name}: shared placement requires a compiled org connector`);
      }
      if (selection.chats !== undefined && (!Array.isArray(selection.chats) ||
          !selection.chats.every((chat) => typeof chat === "string" && uuid.test(chat)))) {
        throw new Error(`${name}: the chat allowlist must contain Guild chat UUIDs`);
      }
      const targetPolicy = {
        ...(selection.chats === undefined ? {} : { chats: selection.chats }),
        ...(selection.memberTools === undefined ? {} : { memberTools: selection.memberTools }),
        ...(selection.services === undefined ? {} : { services: selection.services }),
        ...(selection.source === "personal" ? { personal: true } : {}),
      };
      let endpoint: string;
      let headers: Record<string, string>;
      if (selection.source === "personal") {
        const owner = selection.owner;
        if (!owner || !uuid.test(owner)) throw new Error(`${name}: a personal MCP target requires its owner UUID`);
        const row = await users.get(org, owner, id);
        if (!row?.enabled) throw new Error(`${name}: enabled personal MCP row missing`);
        endpoint = row.url;
        headers = users.resolveHeaders(row.headers_enc, key);
      } else {
        if (selection.source !== "org" || !Array.isArray(selection.members) ||
            !selection.members.every((member) => typeof member === "string" && uuid.test(member))) {
          throw new Error(`${name}: an org target requires an explicit member allowlist`);
        }
        const row = await orgs.get(org, id);
        if (!row?.enabled) throw new Error(`${name}: enabled org integration row missing`);
        const rowConfig = object(row.config ?? {});
        const legacyMcp = rowConfig["mcp"];
        const values = await integrationSecrets.resolve(org, row.name, await integrationSecrets.names(org, row.name), key);
        if (legacyMcp !== null && typeof legacyMcp === "object" && !Array.isArray(legacyMcp)) {
          if (selection.placement === "shared") throw new Error(`${name}: shared placement requires a compiled connector`);
          const mcp = object(legacyMcp);
          if (typeof mcp["url"] !== "string") throw new Error(`${name}: MCP URL missing`);
          endpoint = mcp["url"];
          headers = mcpRequestHeaders({ ...rowConfig, mcp: { ...mcp, envelope: false } },
            { orgId: org, callId: "", caller: null, actingAs: null }, values);
          if (mcp["envelope"] !== false) {
            if (selection.identityEnvelope !== true || legacyProxies.has(id)) {
              throw new Error(`${name}: select the legacy identity envelope explicitly and only once`);
            }
            legacyProxies.add(id);
            const service = `guild-mcp-envelope-${id}`;
            secrets.push(secret(`${service}-settings`, { "settings.json": JSON.stringify({ endpoint, credentials: headers }) }));
            targets.push({
              name, url: `http://${service}.${namespace}.svc.cluster.local:8080/mcp`,
              members: selection.members, tools, legacyEnvelopeProxy: id, ...targetPolicy,
            });
            continue;
          }
        } else {
          const connector = builtinByName(row.name);
          if (!connector) throw new Error(`${name}: deploy this registry connector as a separate MCP service first`);
          if (connectors.has(row.name)) throw new Error(`${name}: the connector is selected twice`);
          const available = new Set((await connector.toolSpecs(rowConfig)).map((tool) => tool.name));
          if (!tools.every((tool) => available.has(tool))) throw new Error(`${name}: allowlist names an unknown connector tool`);
          if (selection.placement === "shared") {
            const shared = Object.hasOwn(sharedVendors, row.name) ? sharedVendors[row.name as keyof typeof sharedVendors] : undefined;
            if (!shared) throw new Error(`${name}: this vendor requires tenant placement`);
            const apiUrl = rowConfig[shared.urlKey];
            const vendorToken = values.find(([key]) => key === shared.secretKey)?.[1];
            if ((apiUrl !== undefined && apiUrl !== shared.url) || !vendorToken || !/^[\x21-\x7e]{1,2048}$/.test(vendorToken)) {
              throw new Error(`${name}: shared placement requires the public vendor URL and a configured token`);
            }
            const service = `guild-mcp-${row.name}`;
            const credential = `${service}-${id}`;
            secrets.push(secret(credential, { token: vendorToken }));
            targets.push({
              name, url: `http://${service}.${namespace}.svc.cluster.local:8080/mcp`,
              members: selection.members, tools, sharedConnector: row.name, sharedCredential: credential, ...targetPolicy,
            });
            sharedConnectors.add(row.name);
            continue;
          }
          connectors.add(row.name);
          const service = `guild-mcp-${row.name.replaceAll("_", "-")}-${org.replaceAll("-", "")}`;
          secrets.push(secret(`${service}-settings`, {
            "settings.json": JSON.stringify({ config: rowConfig, secrets: Object.fromEntries(values) }),
          }));
          const target: JsonObject = {
            name, url: `http://${service}.${namespace}.svc.cluster.local:8080/mcp`,
            members: selection.members, tools, ...targetPolicy,
          };
          if (connector.auth_kind === "org_secret_impersonated") {
            if (name !== "google-workspace") throw new Error("delegated Google target needs name google-workspace");
            target["delegatesActingIdentity"] = true;
          } else {
            const credential = `${service}-access`;
            secrets.push(secret(credential, { Authorization: randomBytes(24).toString("hex") }));
            target["credentialSecret"] = credential;
          }
          targets.push(target);
          continue;
        }
      }

      const target: JsonObject = {
        name, url: endpoint, tools, members: selection.source === "personal" ? [selection.owner] : selection.members,
        ...targetPolicy,
      };
      const entries = Object.entries(headers);
      const headerSecret = `guild-mcp-${id}`;
      if (entries.length > 0) {
        secrets.push(secret(headerSecret, Object.fromEntries(entries.map(([, value], index) => [`header-${index}`, value]))));
        target["credentialHeaders"] = entries.map(([header], index) => ({ header, secret: headerSecret, key: `header-${index}` }));
      }
      targets.push(target);
    }
    process.stdout.write(JSON.stringify({
      inventory: { org, targets },
      secrets: { apiVersion: "v1", kind: "List", items: secrets },
      connectors: [...connectors],
      sharedConnectors: [...sharedConnectors],
      legacyProxies: [...legacyProxies],
    }) + "\n");
  } finally {
    await pool.end();
  }
}

await run().catch((error) => {
  process.stderr.write((error as Error).message + "\n");
  process.exitCode = 1;
});
