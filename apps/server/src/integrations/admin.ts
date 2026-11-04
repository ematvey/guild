// The integration admin service: the shop listing, configuration create
// and save (config validation, secret merge, connection tests), and the
// tools listing with per-tool curation. The admin routes
// (platform/http/admin.ts) authorize and call through here.

import { randomUUID } from "node:crypto";
import { ApiError } from "../platform/errors.js";
import { isToolClass, toolClassOf } from "../platform/domain/tool-class.js";
import type { IntegrationSecretStore, IntegrationStore } from "../platform/store/integrations.js";
import type { RegistryStore } from "../platform/store/registry.js";
import { builtinByName } from "./loader.js";
import { connectorFor, orgConnectors } from "./connectors.js";
import { isCodeManifest } from "./code-plugins.js";
import type { ObjectStore } from "../platform/s3.js";
import { mcpConnect } from "./mcp.js";
import { manifestSecretNames, namespacedTool, registryManifest, registryManifestIfApproved } from "./plugins.js";
import { mcpToolClass, toolCurate } from "./policy.js";
import { mcpHeaderTemplates, mcpRequestHeaders, validateHeaderTemplates } from "./mcp-headers.js";

/** The stores the admin paths read and write. */
export interface IntegrationAdminDeps {
  readonly integrations: IntegrationStore;
  readonly integrationSecrets: IntegrationSecretStore;
  readonly registry: RegistryStore;
  readonly objects: Pick<ObjectStore, "get">;
  masterKey(): Buffer;
}

/** Currently approved manifest of one registry integration item, if any.
 *  The approval covers only the bundle it hashed: a stored bundle that no
 *  longer matches reads as unapproved. */
async function latestIntegrationManifest(
  gateway: IntegrationAdminDeps,
  orgId: string,
  slug: string,
): Promise<Record<string, unknown> | null> {
  try {
    return await registryManifestIfApproved(gateway, orgId, slug);
  } catch {
    return null;
  }
}

/** Approved manifest for a save: the same approval + bundle-hash check the
 *  turn path enforces, with a missing approval read as null. */
async function saveManifest(
  gateway: IntegrationAdminDeps,
  orgId: string,
  slug: string,
): Promise<Record<string, unknown> | null> {
  try {
    return await registryManifestIfApproved(gateway, orgId, slug);
  } catch (error) {
    throw ApiError.badRequest(`invalid registry manifest: ${(error as Error).message}`);
  }
}

/** One shop entry: the plugin's storefront metadata plus its install state
 *  for this org. The list is one array — the shop shows every integration,
 *  installed or not. */
function shopEntry(
  base: {
    name: string;
    title: string;
    version: string;
    publisher: string;
    summary: string;
    description: string;
    docs_url: string | null;
    logo: string;
    categories: string[];
    traits: Record<string, string>;
    secret_names: string[];
    settings: unknown;
    /** builtin: compiled into the server; registry: an installed code
     *  plugin; mcp: a remote MCP server. */
    source: "builtin" | "registry" | "mcp";
  },
  row: { id: string; org_id: string; config: unknown; enabled: boolean } | null,
): Record<string, unknown> {
  return {
    ...base,
    configured: row !== null,
    id: row?.id ?? null,
    org_id: row?.org_id ?? null,
    config: row?.config ?? {},
    enabled: row?.enabled ?? false,
  };
}

/** The integration shop: every connector of the org (built-ins and
 *  installed code plugins) with its storefront metadata and this org's
 *  install state, plus the approved registry MCP plugins. One list; the
 *  client filters and renders it. */
export async function integrationShop(
  gateway: IntegrationAdminDeps,
  orgId: string,
): Promise<Record<string, unknown>[]> {
  const rows = await gateway.integrations.list(orgId);
  const items: Record<string, unknown>[] = [];
  const rowByName = new Map(rows.map((r) => [r.name, r]));
  for (const connector of await orgConnectors(gateway, orgId)) {
    const row = rowByName.get(connector.name) ?? null;
    // A registry bundle of the same slug shadows the compiled-in kind.
    const manifest = row === null ? null : await latestIntegrationManifest(gateway, orgId, connector.name);
    const mcpClaimed = manifest !== null && manifest["mcp"] !== null && manifest["mcp"] !== undefined;
    if (mcpClaimed) continue;
    items.push(
      shopEntry(
        {
          name: connector.name,
          title: connector.title,
          version: connector.version,
          publisher: connector.publisher,
          summary: connector.summary,
          description: connector.description,
          docs_url: connector.docs_url,
          logo: connector.logo,
          categories: connector.categories,
          traits: connector.traits,
          secret_names: connector.secret_names,
          settings: connector.fields.length > 0 ? { fields: connector.fields } : null,
          source: connector.origin,
        },
        row,
      ),
    );
  }
  for (const item of await gateway.registry.listItems(orgId, "integration")) {
    if (item.review_status !== "approved") continue;
    const manifest = await latestIntegrationManifest(gateway, orgId, item.slug);
    if (manifest === null || manifest["mcp"] === null || manifest["mcp"] === undefined) continue;
    const auth = (manifest["auth"] ?? null) as Record<string, unknown> | null;
    const secretNames = Array.isArray(auth?.["secret_names"]) ? (auth["secret_names"] as string[]) : [];
    items.push(
      shopEntry(
        {
          name: item.slug,
          title: typeof manifest["title"] === "string" ? (manifest["title"] as string) : item.slug,
          version: typeof manifest["version"] === "string" ? (manifest["version"] as string) : "",
          publisher: typeof manifest["publisher"] === "string" ? (manifest["publisher"] as string) : "Registry",
          summary:
            typeof manifest["summary"] === "string"
              ? (manifest["summary"] as string)
              : typeof manifest["description"] === "string"
                ? (manifest["description"] as string)
                : "",
          description: typeof manifest["description"] === "string" ? (manifest["description"] as string) : "",
          docs_url: typeof manifest["docs_url"] === "string" ? (manifest["docs_url"] as string) : null,
          logo: typeof manifest["logo"] === "string" ? (manifest["logo"] as string) : "",
          categories: ["mcp"],
          traits: {},
          secret_names: secretNames,
          settings: manifest["settings"] ?? null,
          source: "mcp",
        },
        rowByName.get(item.slug) ?? null,
      ),
    );
  }
  return items;
}

/** Creates a configuration row for a not-yet-configured connector: a
 *  compiled-in kind or an installed registry v2 MCP plugin. */
export async function createIntegration(
  gateway: IntegrationAdminDeps,
  orgId: string,
  name: string,
  body: Record<string, unknown>,
): Promise<void> {
  const rows = await gateway.integrations.list(orgId);
  if (rows.some((r) => r.name === name)) {
    throw ApiError.conflict("already_configured", `integration ${name} already has a configuration`);
  }
  // Known connectors only: a compiled-in kind, or an installed registry v2
  // bundle whose manifest declares an MCP server.
  const manifest = await latestIntegrationManifest(gateway, orgId, name);
  const known = builtinByName(name) !== undefined || manifest?.["mcp"] != null || isCodeManifest(manifest);
  if (!known) throw ApiError.notFound(`unknown integration ${name}`);
  await saveIntegration(gateway, orgId, name, null, body);
}

/** The full, unfiltered tool list of one integration row with each tool's
 *  stored per-tool config. Built-in (adapter-bound) rows read their
 *  compiled-in declarations; MCP rows connect live and merge the discovered
 *  tools with the stored config. A disabled row reports `resolved: false`
 *  without connecting; a broken plugin reports the resolution error — never
 *  a silent empty list. */
export async function integrationTools(
  gateway: IntegrationAdminDeps,
  orgId: string,
  id: string,
): Promise<Record<string, unknown>> {
  const integrationRow = await gateway.integrations.get(orgId, id);
  if (integrationRow === null) throw ApiError.notFound("unknown integration");
  const rowConfig = (integrationRow.config ?? {}) as Record<string, unknown>;
  const mcpUrl = readMcpUrl(rowConfig);
  if (mcpUrl === null) {
    const connector = await connectorOrError(gateway, orgId, integrationRow.name);
    if (connector === undefined) {
      throw ApiError.notFound(`unknown integration kind ${integrationRow.name}`);
    }
    let specs;
    try {
      specs = await connector.toolSpecs(rowConfig);
    } catch (error) {
      throw ApiError.badRequest(`invalid integration config: ${(error as Error).message}`);
    }
    const tools = specs.map((spec) =>
      curatedToolJson(
        spec.name,
        integrationRow.name,
        toolClassOf(connector, spec.name),
        spec.description,
        false,
        rowConfig,
      ),
    );
    return { resolved: true, kind: "connector", tools };
  }
  // MCP-bound: live discovery merged with the stored config. A disabled
  // row is not resolved (it serves nothing); a reachable one lists every
  // tool it currently serves, each with the stored curation (absent =
  // disabled, so remote drift lands visible-but-off).
  if (!integrationRow.enabled) {
    return { resolved: false, kind: "mcp", reason: "integration disabled", tools: [] };
  }
  let manifest: Record<string, unknown>;
  try {
    manifest = await registryManifest(gateway, orgId, integrationRow.name);
  } catch (error) {
    throw ApiError.badRequest(`no registry manifest: ${(error as Error).message}`);
  }
  // The auth block's declared list — the same source the connector's
  // registry bundle declares (not the settings-derived list).
  const auth = manifest["auth"];
  const secretNames =
    auth !== null && typeof auth === "object" && Array.isArray((auth as Record<string, unknown>)["secret_names"])
      ? ((auth as Record<string, unknown>)["secret_names"] as string[])
      : [];
  let secrets: [string, string][];
  try {
    secrets = await gateway.integrationSecrets.resolve(orgId, integrationRow.name, secretNames, gateway.masterKey());
  } catch (error) {
    throw ApiError.conflict("missing_secrets", (error as Error).message);
  }
  const headers = mcpRequestHeaders(rowConfig, { callId: randomUUID(), orgId, caller: null, actingAs: null }, secrets);
  let peer;
  try {
    peer = await mcpConnect(mcpUrl, headers);
  } catch (error) {
    throw ApiError.badRequest(`MCP server unreachable: ${(error as Error).message}`);
  }
  let listed;
  try {
    listed = await peer.listTools();
  } catch (error) {
    throw ApiError.badRequest(`MCP tools/list failed: ${(error as Error).message}`);
  }
  const tools = listed.map((t) =>
    curatedToolJson(
      t.name,
      integrationRow.name,
      mcpToolClass(rowConfig, manifest, t.name),
      t.description,
      true,
      rowConfig,
    ),
  );
  return { resolved: true, kind: "mcp", tools };
}

/** The org's connector of one slug; a code plugin that fails to load is a
 *  400 with the load error. */
async function connectorOrError(gateway: IntegrationAdminDeps, orgId: string, name: string) {
  try {
    return await connectorFor(gateway, orgId, name);
  } catch (error) {
    throw ApiError.badRequest(`integration ${name} failed to load: ${(error as Error).message}`);
  }
}

/** The mcp.url setting of an integration row config, when set. */
function readMcpUrl(config: Record<string, unknown>): string | null {
  const mcp = config["mcp"];
  if (mcp !== null && typeof mcp === "object" && !Array.isArray(mcp)) {
    const url = (mcp as Record<string, unknown>)["url"];
    if (typeof url === "string") return url;
  }
  return null;
}

// ---------- integration save path (create/update with connection tests) ----------

/** Validates an MCP plugin row's config: mcp.url must be an absolute http(s)
 *  URL when present; tool_policy role keys ⊆ {member, admin} with class
 *  lists ⊆ {read, write, admin}. */
function validateMcpConfig(config: Record<string, unknown>): void {
  const mcp = config["mcp"];
  const url =
    mcp !== null && typeof mcp === "object" && !Array.isArray(mcp)
      ? (mcp as Record<string, unknown>)["url"]
      : undefined;
  if (typeof url === "string" && !url.startsWith("http://") && !url.startsWith("https://")) {
    throw ApiError.badRequest("mcp.url must be an absolute http(s) URL");
  }
  const templates = mcpHeaderTemplates(config);
  if (templates !== null) {
    try {
      validateHeaderTemplates(templates);
    } catch (error) {
      throw ApiError.badRequest((error as Error).message);
    }
  }
  const policy = config["tool_policy"];
  if (policy !== null && typeof policy === "object" && !Array.isArray(policy)) {
    for (const [role, classes] of Object.entries(policy as Record<string, unknown>)) {
      if (role !== "member" && role !== "admin") {
        throw ApiError.badRequest("tool_policy role keys must be member or admin");
      }
      if (!Array.isArray(classes)) {
        throw ApiError.badRequest("tool_policy role value must be a class list");
      }
      for (const c of classes) {
        if (!isToolClass(c)) {
          throw ApiError.badRequest("tool_policy classes must be read, write, or admin");
        }
      }
    }
  }
}

/** Connection test for an MCP plugin: a full pool connect plus tools/list
 *  handshake with the would-be secret headers. */
async function mcpTestConnection(
  config: Record<string, unknown>,
  url: string,
  secrets: [string, string][],
  orgId: string,
): Promise<void> {
  const headers = mcpRequestHeaders(config, { callId: randomUUID(), orgId, caller: null, actingAs: null }, secrets);
  let peer;
  try {
    peer = await mcpConnect(url, headers);
  } catch (error) {
    throw ApiError.badRequest(`MCP server unreachable: ${(error as Error).message}`);
  }
  try {
    await peer.listTools();
  } catch (error) {
    throw ApiError.badRequest(`MCP tools/list failed: ${(error as Error).message}`);
  }
}

/** Shared save path for create and update (save_integration): applies the
 *  registry-shadowing rules, validates
 *  required fields, merges newly entered credential values in memory, runs
 *  the connector's connection test against the would-be state, and persists
 *  (config, secrets, enabled) only on success — a broken connection is
 *  never stored. */
export async function saveIntegration(
  gateway: IntegrationAdminDeps,
  orgId: string,
  name: string,
  existing: { config: unknown; enabled: boolean } | null,
  body: Record<string, unknown>,
): Promise<void> {
  const master = gateway.masterKey();
  const existingConfig = (existing?.config ?? {}) as Record<string, unknown>;
  // A create-stub (POST with just a name) registers the row disabled and
  // empty: the completeness check and connection test apply to every real
  // save of settings or credentials.
  const isStubCreate =
    existing === null && body["config"] === undefined && body["enabled"] === undefined && body["secrets"] === undefined;
  if (isStubCreate) {
    // An MCP plugin from the registry seeds its stub with the manifest's
    // mcp/auth blocks (as registry install does): the settings editor can
    // then complete and enable it — an empty stub can never enable.
    const manifest = await saveManifest(gateway, orgId, name);
    const config: Record<string, unknown> =
      manifest !== null && manifest["mcp"] != null
        ? {
            mcp: manifest["mcp"],
            auth: manifest["auth"] ?? { kind: "org_secret", secret_names: [], identity_key: "email" },
            tool_policy: {},
          }
        : {};
    await gateway.integrations.upsert(orgId, name, config, false);
    return;
  }
  const registryManifestValue = await saveManifest(gateway, orgId, name);
  const v2Claimed =
    (registryManifestValue !== null && registryManifestValue["mcp"] != null) || readMcpUrl(existingConfig) !== null;
  // Newly entered credential values: only non-empty strings are writes; an
  // untouched field stays as stored (standard CRUD update).
  const submitted: [string, string][] = Object.entries(
    body["secrets"] !== null && typeof body["secrets"] === "object" && !Array.isArray(body["secrets"])
      ? (body["secrets"] as Record<string, unknown>)
      : {},
  )
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1] !== "")
    .map(([k, v]) => [k, v]);
  if (v2Claimed) {
    // v2 MCP plugin installed from the registry: config fields merge
    // shallowly over the stored row (an empty object on create) so partial
    // updates keep mcp/auth. The tools curation map never comes from a
    // settings save — the PUT tools endpoint is its only writer.
    const config: Record<string, unknown> = { ...existingConfig };
    const patch = body["config"];
    if (patch !== null && typeof patch === "object" && !Array.isArray(patch)) {
      for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
        if (k === "tools") continue;
        config[k] = v;
      }
    }
    validateMcpConfig(config);
    const enabled = typeof body["enabled"] === "boolean" ? body["enabled"] : (existing?.enabled ?? false);
    const declared = manifestSecretNames(registryManifestValue ?? {});
    if (enabled && readMcpUrl(config) === null) {
      throw ApiError.badRequest("mcp plugin needs an mcp.url before enabling");
    }
    // Resolve stored secrets, overlay the submitted values in memory, and
    // test the connection before anything is written. A save that neither
    // enables nor writes credentials touches neither.
    if (declared.length > 0 || submitted.length > 0) {
      let secrets = await gateway.integrationSecrets.resolve(
        orgId,
        name,
        await gateway.integrationSecrets.names(orgId, name),
        master,
      );
      for (const [k, v] of submitted) {
        secrets = secrets.filter(([n]) => n !== k);
        secrets.push([k, v]);
      }
      if (enabled) {
        const missing = declared.filter((d) => !secrets.some(([n]) => n === d));
        if (missing.length > 0) {
          throw ApiError.conflict("missing_secrets", `missing secrets: ${missing.join(", ")}`);
        }
        await mcpTestConnection(config, readMcpUrl(config) ?? "", secrets, orgId);
      }
    }
    await gateway.integrations.saveWithSecrets(
      gateway.integrationSecrets,
      orgId,
      name,
      config,
      enabled,
      submitted,
      master,
    );
    return;
  }
  const connector = await connectorOrError(gateway, orgId, name);
  if (connector === undefined) throw ApiError.notFound(`unknown integration ${name}`);
  const config = body["config"] !== undefined ? body["config"] : (existing?.config ?? {});
  // Per-tool curation is admin state with a single writer — the PUT tools
  // endpoint. A settings save never changes it: the client-sent tools map (a
  // stale snapshot by definition) is dropped and the stored selection rides
  // through.
  if (config !== null && typeof config === "object" && !Array.isArray(config)) {
    const obj = config as Record<string, unknown>;
    delete obj["tools"];
    if (existing !== null && existingConfig["tools"] !== undefined) {
      obj["tools"] = existingConfig["tools"];
    }
  }
  const configForTools = (config ?? {}) as Record<string, unknown>;
  // Validate via the connector's own config check before saving.
  try {
    await connector.toolSpecs(configForTools);
  } catch (error) {
    throw ApiError.badRequest(`invalid integration config: ${(error as Error).message}`);
  }
  const schemaFields = connector.fields;
  const enabled = typeof body["enabled"] === "boolean" ? body["enabled"] : (existing?.enabled ?? false);
  // Required settings must be filled (a missing optional falls back to the
  // manifest default or stays absent). Credential fields are skipped here —
  // they are enforced by the missing-secrets gate below, which reports the
  // proper conflict code.
  for (const f of schemaFields) {
    if (!f.required || f.kind === "secret") continue;
    const value = configForTools[f.name];
    const present = f.kind === "boolean" ? typeof value === "boolean" : typeof value === "string" && value !== "";
    if (!present) {
      const label = f.label ?? f.name;
      throw ApiError.badRequest(`field ${label} is required`);
    }
  }
  // Merge stored + submitted credentials in memory and test before anything
  // is written.
  const declared = schemaFields.filter((f) => f.kind === "secret").map((f) => f.name);
  let secrets = await gateway.integrationSecrets.resolve(
    orgId,
    name,
    await gateway.integrationSecrets.names(orgId, name),
    master,
  );
  for (const [k, v] of submitted) {
    secrets = secrets.filter(([n]) => n !== k);
    secrets.push([k, v]);
  }
  if (enabled) {
    const missing = declared.filter((d) => !secrets.some(([n]) => n === d));
    if (missing.length > 0) {
      throw ApiError.conflict("missing_secrets", `missing secrets: ${missing.join(", ")}`);
    }
  }
  try {
    await connector.testConnection(configForTools, secrets);
  } catch (error) {
    throw ApiError.badRequest((error as Error).message);
  }
  await gateway.integrations.saveWithSecrets(
    gateway.integrationSecrets,
    orgId,
    name,
    config,
    enabled,
    submitted,
    master,
  );
}

/** One declared/served tool with its stored per-tool curation, as the admin
 *  Tools table renders it. */
function curatedToolJson(
  rawName: string,
  slug: string,
  cls: string,
  description: string,
  mcp: boolean,
  rowConfig: Record<string, unknown>,
): Record<string, unknown> {
  const curate = toolCurate(rowConfig, mcp, rawName);
  return {
    name: rawName,
    tool: namespacedTool(slug, rawName),
    class: cls,
    description,
    enabled: curate.enabled,
    approval: curate.alwaysAsk ? "always_ask" : curate.alwaysAllow ? "always_allow" : "default",
  };
}
