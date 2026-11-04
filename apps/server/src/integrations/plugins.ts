// Turn-start integration resolution (resolve_integrations): the snapshot
// shape built-in integrations and MCP plugins resolve through — the tool
// list with manifest classes, policy-filtered by role. Secrets are checked
// (declared names must be stored) but only their presence — values are
// re-resolved at call time.

import { randomUUID } from "node:crypto";
import { builtinMcpByName, type IntegrationToolSpec, type Connector } from "./loader.js";
import { traitSpec } from "@guild/integration-sdk";
import { connectorFor, readTraitBindings, type ConnectorSource, type TraitBindings } from "./connectors.js";
import type { OrgKvStore } from "../platform/store/org-kv.js";
import { toolClassOf } from "../platform/domain/tool-class.js";
import { mcpRequestHeaders } from "./mcp-headers.js";
import { mcpToolClass } from "./policy.js";
import { mcpConnect, type McpTool } from "./mcp.js";
import type { JsonObject } from "./shared.js";

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
 *  slice): the integration rows, the secret store, the registry whose
 *  approvals gate MCP manifests and code plugins, the object store the code
 *  bundles load from, and the org KV holding the trait bindings. */
export interface IntegrationGateway extends PluginSecretSource, ConnectorSource {
  integrations: {
    listEnabled(orgId: string): Promise<{ name: string; config: unknown; enabled: boolean }[]>;
  };
  orgKv: Pick<OrgKvStore, "get">;
}

/** How a plugin executes: an in-process connector (a built-in or an
 *  approved registry code plugin) or a remote MCP server. */
export type IntegrationExecutor = "connector" | "mcp";

export interface IntegrationToolInfo {
  /** The declaration the model sees. For a trait tool this is the
   *  Guild-provided spec, not the provider's. */
  spec: IntegrationToolSpec;
  class: string;
  /** The provider's own tool name — what the connector receives. */
  raw: string;
  /** The trait this tool implements, when it implements one. */
  trait?: string;
}

/** The trait a connector's tool implements, when its manifest maps one to
 *  it. */
function traitOfTool(connector: Connector, raw: string): string | undefined {
  for (const [trait, tool] of Object.entries(connector.traits)) {
    if (tool === raw) return trait;
  }
  return undefined;
}

/** Resolution snapshot for one enabled plugin — everything the script API
 *  routes need: the executor kind, the tool list, and the row config. */
export interface IntegrationTurn {
  executor: IntegrationExecutor;
  slug: string;
  description: string;
  tools: IntegrationToolInfo[];
  rowConfig: JsonObject;
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

/** The manifest an integration is served under: a built-in MCP plugin's
 *  (shipping with Guild is its approval), else the registry manifest whose
 *  content an admin's approval covers — resolved only while the item is
 *  approved AND the approval's recorded version is still the latest (a
 *  republish resets the review status). */
export async function approvedManifest(
  gateway: Pick<IntegrationGateway, "registry">,
  orgId: string,
  slug: string,
): Promise<JsonObject | null> {
  const builtin = builtinMcpByName(slug);
  if (builtin !== undefined) return builtin.manifest;
  const approved = await gateway.registry.approvedBundle(orgId, "integration", slug);
  if (approved === null) return null;
  const [version, bundleSha256] = approved;
  const stored = await gateway.registry.getVersion(orgId, "integration", slug, version);
  if (stored.bundle_sha256 !== bundleSha256) {
    throw new Error(`registry item ${slug}: stored bundle no longer matches the approved hash`);
  }
  return (stored.manifest ?? {}) as JsonObject;
}

export async function requireApprovedManifest(
  gateway: Pick<IntegrationGateway, "registry">,
  orgId: string,
  slug: string,
): Promise<JsonObject> {
  const manifest = await approvedManifest(gateway, orgId, slug);
  if (manifest === null) {
    throw new Error(`registry item ${slug} has no approval covering its latest version and bundle`);
  }
  return manifest;
}

/** Secret names a v2 manifest declares: the settings schema's secret-kind
 *  fields when it yields any, else the auth block's list. */
export function manifestSecretNames(manifest: JsonObject): string[] {
  const settings = manifest["settings"];
  if (settings !== null && typeof settings === "object" && Array.isArray((settings as JsonObject)["fields"])) {
    const derived = ((settings as JsonObject)["fields"] as JsonObject[])
      .filter((f) => f["kind"] === "secret" && typeof f["name"] === "string")
      .map((f) => f["name"] as string);
    if (derived.length > 0) return derived;
  }
  const auth = manifest["auth"];
  if (auth !== null && typeof auth === "object" && Array.isArray((auth as JsonObject)["secret_names"])) {
    return (auth as JsonObject)["secret_names"] as string[];
  }
  return [];
}

function toMcpToolInfo(slug: string, manifest: JsonObject, rowConfig: JsonObject, tool: McpTool): IntegrationToolInfo {
  return {
    spec: {
      name: namespacedTool(slug, tool.name),
      description: tool.description,
      parameters: tool.inputSchema,
    },
    class: mcpToolClass(rowConfig, manifest, tool),
    raw: tool.name,
  };
}

/** Turn-start resolution for the enabled plugins of one org: connectors
 *  (built-ins and approved code plugins) declare their tools from the
 *  manifest; MCP plugins connect
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
    const config = (row.config ?? {}) as JsonObject;
    // An installed v2 bundle is the admin's explicit choice — a row
    // carrying an mcp.url resolves as MCP even when a compiled-in connector
    // of the same slug exists.
    const mcpUrl =
      config["mcp"] !== null && typeof config["mcp"] === "object" && !Array.isArray(config["mcp"])
        ? (config["mcp"] as JsonObject)["url"]
        : undefined;
    if (typeof mcpUrl !== "string" || mcpUrl === "") {
      let connector: Connector | undefined;
      try {
        connector = await connectorFor(gateway, orgId, row.name);
      } catch (error) {
        warn(`${(error as Error).message}, skipping`);
        continue;
      }
      if (connector === undefined) continue; // unknown kind with no mcp.url — nothing to resolve
      const secretNames = connector.secret_names;
      // Presence check only — values never ride the snapshot.
      try {
        await gateway.integrationSecrets.resolve(orgId, row.name, secretNames, masterKey);
      } catch {
        warn(`integration ${row.name}: secrets unresolved, skipping`);
        continue;
      }
      let specs: IntegrationToolSpec[];
      try {
        specs = await connector.toolSpecs(config);
      } catch {
        warn(`integration ${row.name}: broken config, skipping`);
        continue;
      }
      const resolved = connector;
      out.push({
        executor: "connector",
        slug: row.name,
        description: resolved.summary,
        tools: specs.map((spec) => {
          const trait = traitOfTool(resolved, spec.name);
          return {
            spec: { ...spec, name: namespacedTool(row.name, spec.name) },
            class: toolClassOf(resolved, spec.name),
            raw: spec.name,
            ...(trait !== undefined ? { trait } : {}),
          };
        }),
        rowConfig: config,
        secretNames,
        identityKey: resolved.identity_key,
      });
      continue;
    }
    // MCP plugin: tools come from the plugin server's list_tools, classes
    // from the registry manifest. The connect happens before curation
    // filtering deliberately: drift detection (new remote tools landing
    // disabled) requires the live list.
    let manifest: JsonObject;
    try {
      manifest = await requireApprovedManifest(gateway, orgId, row.name);
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
      peer = await mcpConnect(
        mcpUrl,
        mcpRequestHeaders(config, { callId: randomUUID(), orgId, caller: null, actingAs: null }, secrets),
      );
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
      tools: listed.map((t) => toMcpToolInfo(row.name, manifest, config, t)),
      rowConfig: config,
      secretNames,
      identityKey:
        auth !== null && typeof auth === "object" && typeof (auth as JsonObject)["identity_key"] === "string"
          ? ((auth as JsonObject)["identity_key"] as string)
          : "email",
    });
  }
  assignTraits(out, await readTraitBindings(gateway.orgKv, orgId));
  return out;
}

/** Trait tools take their Guild-provided name, description, and schema, and
 *  one integration answers each trait: the org's bound provider when it is
 *  among the resolved integrations, else the first one declaring it. The
 *  model never sees two tools with the same name; the losers keep their
 *  other tools. */
export function assignTraits(turns: IntegrationTurn[], bindings: TraitBindings = {}): void {
  const winner = new Map<string, string>();
  for (const turn of turns) {
    for (const info of turn.tools) {
      if (info.trait === undefined) continue;
      const bound = bindings[info.trait];
      const boundPresent =
        bound !== undefined && turns.some((t) => t.slug === bound && t.tools.some((i) => i.trait === info.trait));
      if (boundPresent) winner.set(info.trait, bound);
      else if (!winner.has(info.trait)) winner.set(info.trait, turn.slug);
    }
  }
  for (const turn of turns) {
    const kept: IntegrationToolInfo[] = [];
    for (const info of turn.tools) {
      if (info.trait === undefined) {
        kept.push(info);
        continue;
      }
      const spec = traitSpec(info.trait);
      if (spec === undefined || winner.get(info.trait) !== turn.slug) continue;
      kept.push({ ...info, spec: { name: spec.name, description: spec.description, parameters: spec.parameters } });
    }
    turn.tools = kept;
  }
}
