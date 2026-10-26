// Turn-start integration resolution (resolve_integrations): the snapshot
// shape built-in integrations and MCP plugins resolve through — the tool
// list with manifest classes, policy-filtered by role. Secrets are checked
// (declared names must be stored) but only their presence — values are
// re-resolved at call time.

import { randomUUID } from "node:crypto";
import { integrationByName, type IntegrationToolSpec } from "../integration-catalog.js";
import { manifestToolClass, toolClassOf } from "../domain/tool-class.js";
import { mcpConnect, type McpTool } from "./mcp.js";

export type Json = Record<string, unknown>;

/** The narrow store surface the dispatcher re-resolves secrets through
 *  (structurally the GatewayCtx slice; no store values ride the snapshot). */
export interface PluginSecretSource {
  integrationSecrets: {
    names(orgId: string, integration: string): Promise<string[]>;
    resolve(orgId: string, integration: string, names: string[], masterKey: Buffer): Promise<[string, string][]>;
  };
  masterKey(): Buffer;
}

/** The gateway slice plugin resolution needs (structurally the GatewayCtx
 *  slice): the integration rows, the secret store, and the registry whose
 *  approvals gate MCP manifests + guide bundles. */
export interface IntegrationGateway extends PluginSecretSource {
  integrations: {
    listEnabled(orgId: string): Promise<{ name: string; config: unknown; enabled: boolean }[]>;
  };
  registry: {
    approvedBundle(orgId: string, kind: string, slug: string): Promise<[string, string] | null>;
    getVersion(orgId: string, kind: string, slug: string, version: string): Promise<{ manifest: unknown; bundle_sha256: string | null; object_key: string }>;
  };
}

/** How a plugin executes: a compiled-in connector or a remote MCP server. */
export type IntegrationExecutor = "rust" | "mcp";

export interface IntegrationToolInfo {
  spec: IntegrationToolSpec;
  class: string;
}

/** Resolution snapshot for one enabled plugin — everything the script API
 *  routes need: the executor kind, the tool list, and the row config. */
export interface IntegrationTurn {
  executor: IntegrationExecutor;
  slug: string;
  description: string;
  tools: IntegrationToolInfo[];
  rowConfig: Json;
  secretNames: string[];
  identityKey: string;
}

/** Guild-provided tool name for a plugin tool: `<slug>_<tool>`. */
export function namespacedTool(slug: string, tool: string): string {
  return `${slug}_${tool}`;
}

/** Strips the `<slug>_` namespace back off. Tolerates the legacy
 *  `int_<slug>_` shape so journals recorded before the prefix drop still
 *  resolve. */
export function unnamespacedTool(slug: string, tool: string): string | null {
  const prefix = `${slug}_`;
  if (tool.startsWith(prefix)) return tool.slice(prefix.length);
  const legacy = `int_${slug}_`;
  if (tool.startsWith(legacy)) return tool.slice(legacy.length);
  return null;
}

/** The manifest whose content an admin's approval covers: resolved only
 *  while the item is approved AND the approval's recorded version is still
 *  the latest — a republish resets the review status. */
export async function registryManifestIfApproved(gateway: IntegrationGateway, orgId: string, slug: string): Promise<Json | null> {
  const approved = await gateway.registry.approvedBundle(orgId, "integration", slug);
  if (approved === null) return null;
  const [version, bundleSha256] = approved;
  const stored = await gateway.registry.getVersion(orgId, "integration", slug, version);
  if (stored.bundle_sha256 !== bundleSha256) {
    throw new Error(`registry item ${slug}: stored bundle no longer matches the approved hash`);
  }
  return (stored.manifest ?? {}) as Json;
}

export async function registryManifest(gateway: IntegrationGateway, orgId: string, slug: string): Promise<Json> {
  const manifest = await registryManifestIfApproved(gateway, orgId, slug);
  if (manifest === null) {
    throw new Error(`registry item ${slug} has no approval covering its latest version and bundle`);
  }
  return manifest;
}

/** Secret names a v2 manifest declares: the settings schema's secret-kind
 *  fields when it yields any, else the auth block's list. */
export function manifestSecretNames(manifest: Json): string[] {
  const settings = manifest["settings"];
  if (settings !== null && typeof settings === "object" && Array.isArray((settings as Json)["fields"])) {
    const derived = ((settings as Json)["fields"] as Json[])
      .filter((f) => f["kind"] === "secret" && typeof f["name"] === "string")
      .map((f) => f["name"] as string);
    if (derived.length > 0) return derived;
  }
  const auth = manifest["auth"];
  if (auth !== null && typeof auth === "object" && Array.isArray((auth as Json)["secret_names"])) {
    return (auth as Json)["secret_names"] as string[];
  }
  return [];
}

/** The identity envelope headers (x-guild-org / -caller / -acting-as /
 *  -call-id) plus the secret headers, for the MCP transport. Secrets appear
 *  only here — never in logs or events. */
export function envelopeHeaders(
  callId: string,
  orgId: string,
  caller: string | null,
  actingAs: string | null,
  secrets: [string, string][],
): Record<string, string> {
  const headers: Record<string, string> = {
    "x-guild-org": orgId,
    "x-guild-call-id": callId,
  };
  if (caller !== null) headers["x-guild-caller"] = caller;
  if (actingAs !== null) headers["x-guild-acting-as"] = actingAs;
  for (const [name, value] of secrets) {
    if (!/^[a-z0-9_-]+$/.test(name)) continue; // undeclarable name — never leak it by other means
    headers[`x-guild-secret-${name}`] = value;
  }
  return headers;
}

function toMcpToolInfo(slug: string, manifest: Json, tool: McpTool): IntegrationToolInfo {
  return {
    spec: {
      name: namespacedTool(slug, tool.name),
      description: tool.description,
      parameters: tool.inputSchema,
    },
    class: manifestToolClass(manifest, tool.name),
  };
}

/** Turn-start resolution for the enabled plugins of one org: built-in
 *  connectors resolve from the compiled-in catalogs; MCP plugins connect
 *  live and merge the discovered tools. A broken plugin degrades: skipped
 *  with a warning, the caller continues without it. */
export async function resolveIntegrations(
  gateway: IntegrationGateway,
  orgId: string,
  warn: (message: string) => void = () => {},
): Promise<IntegrationTurn[]> {
  const rows = await gateway.integrations.listEnabled(orgId);
  const masterKey = gateway.masterKey();
  const out: IntegrationTurn[] = [];
  for (const row of rows) {
    const config = (row.config ?? {}) as Json;
    // An installed v2 bundle is the admin's explicit choice — a row
    // carrying an mcp.url resolves as MCP even when a compiled-in connector
    // of the same slug exists.
    const mcpUrl = config["mcp"] !== null && typeof config["mcp"] === "object" && !Array.isArray(config["mcp"])
      ? (config["mcp"] as Json)["url"]
      : undefined;
    if (typeof mcpUrl !== "string" || mcpUrl === "") {
      const connector = integrationByName(row.name);
      if (connector === undefined) continue; // unknown kind with no mcp.url — nothing to resolve
      const secretNames = catalogSecretNames(row.name);
      // Presence check only — values never ride the snapshot.
      try {
        await gateway.integrationSecrets.resolve(orgId, row.name, secretNames, masterKey);
      } catch {
        warn(`integration ${row.name}: secrets unresolved, skipping`);
        continue;
      }
      let specs: IntegrationToolSpec[];
      try {
        specs = connector.tools(config);
      } catch {
        warn(`integration ${row.name}: broken config, skipping`);
        continue;
      }
      out.push({
        executor: "rust",
        slug: row.name,
        description: catalogDescription(row.name),
        tools: specs.map((spec) => ({
          spec: { ...spec, name: namespacedTool(row.name, spec.name) },
          class: toolClassOf(connector, spec.name),
        })),
        rowConfig: config,
        secretNames,
        identityKey: catalogIdentityKey(row.name),
      });
      continue;
    }
    // MCP plugin: tools come from the plugin server's list_tools, classes
    // from the registry manifest. The connect happens before curation
    // filtering deliberately: drift detection (new remote tools landing
    // disabled) requires the live list.
    let manifest: Json;
    try {
      manifest = await registryManifest(gateway, orgId, row.name);
    } catch {
      warn(`integration ${row.name}: no registry manifest, skipping`);
      continue;
    }
    const secretNames = manifestSecretNames(manifest);
    let secrets: [string, string][];
    try {
      secrets = await gateway.integrationSecrets.resolve(orgId, row.name, secretNames, masterKey);
    } catch {
      warn(`integration ${row.name}: secrets unresolved, skipping`);
      continue;
    }
    let peer;
    try {
      peer = await mcpConnect(mcpUrl, envelopeHeaders(randomUUID(), orgId, null, null, secrets));
    } catch {
      warn(`integration ${row.name} unreachable, skipping`);
      continue;
    }
    let listed: McpTool[];
    try {
      listed = await peer.listTools();
    } catch {
      warn(`integration ${row.name}: list_tools failed, skipping`);
      continue;
    }
    const auth = manifest["auth"];
    out.push({
      executor: "mcp",
      slug: row.name,
      description: typeof manifest["description"] === "string" ? (manifest["description"] as string) : "",
      tools: listed.map((t) => toMcpToolInfo(row.name, manifest, t)),
      rowConfig: config,
      secretNames,
      identityKey:
        auth !== null && typeof auth === "object" && typeof (auth as Json)["identity_key"] === "string"
          ? (auth as Json)["identity_key"] as string
          : "email",
    });
  }
  return out;
}

// The compiled-in catalog metadata (src/platform/integration-catalog.ts) —
// description/secret_names/identity_key as the resolve snapshot carries them.

function catalog(name: string) {
  return integrationByName(name);
}

function catalogDescription(name: string): string {
  return catalog(name)?.description ?? "";
}

function catalogSecretNames(name: string): string[] {
  return catalog(name)?.secret_names ?? [];
}

function catalogIdentityKey(name: string): string {
  return catalog(name)?.identity_key ?? "email";
}
