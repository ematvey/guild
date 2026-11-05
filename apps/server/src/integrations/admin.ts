// The integration admin service: the shop listing, configuration create
// and save (config validation, secret merge, connection tests), and the
// tools listing with per-tool curation. The admin routes
// (platform/http/admin.ts) authorize and call through here.

import { randomUUID } from "node:crypto";
import { ApiError } from "../platform/errors.js";
import { toolClassOf } from "../platform/domain/tool-class.js";
import type { IntegrationSecretStore, IntegrationStore } from "../platform/store/integrations.js";
import type { RegistryStore } from "../platform/store/registry.js";
import { BUILTIN_MCP, builtinByName, builtinMcpByName } from "./loader.js";
import { connectorFor, orgConnectors } from "./connectors.js";
import { isCodeManifest } from "./code-plugins.js";
import type { ObjectStore } from "../platform/s3.js";
import { mcpConnect } from "./mcp.js";
import { approvedManifest, namespacedTool, requireApprovedManifest, requiredSecretNames } from "./plugins.js";
import { mcpToolClass, toolCurate } from "./policy.js";
import { mcpHeaderTemplates, mcpRequestHeaders, validateHeaderTemplates } from "./mcp-headers.js";
import { parseBundle, readBundleFile } from "../platform/bundle.js";

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
    return await approvedManifest(gateway, orgId, slug);
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
    return await approvedManifest(gateway, orgId, slug);
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
    /** The README the landing page renders; "" when none ships. */
    readme: string;
    /** The tools the manifest declares (an MCP server's are served live). */
    tools: { name: string; class: string; description: string }[];
  },
  row: { id: string; org_id: string; config: unknown; enabled: boolean } | null,
  storedSecrets: string[],
): Record<string, unknown> {
  return {
    ...base,
    missing: row === null ? [] : missingRequired(base.settings, row.config, storedSecrets),
    configured: row !== null,
    id: row?.id ?? null,
    org_id: row?.org_id ?? null,
    config: row?.config ?? {},
    enabled: row?.enabled ?? false,
  };
}

/** The storefront files of an MCP item's approved bundle (logo.svg,
 *  README.md), per bundle hash: the hash pins the bytes. */
const mcpStoreFiles = new Map<string, Promise<{ logo: string; readme: string }>>();

async function mcpBundleFiles(
  gateway: IntegrationAdminDeps,
  orgId: string,
  slug: string,
): Promise<{ logo: string; readme: string }> {
  const empty = { logo: "", readme: "" };
  try {
    const approved = await gateway.registry.approvedBundle(orgId, "integration", slug);
    if (approved === null) return empty;
    const [version, sha256] = approved;
    let files = mcpStoreFiles.get(sha256);
    if (files === undefined) {
      files = (async () => {
        const stored = await gateway.registry.getVersion(orgId, "integration", slug, version);
        if (stored.bundle_sha256 !== sha256) return empty;
        const parsed = await parseBundle(await gateway.objects.get(stored.object_key));
        return {
          logo: readBundleFile(parsed, "logo.svg")?.toString("utf8") ?? "",
          readme: readBundleFile(parsed, "README.md")?.toString("utf8") ?? "",
        };
      })();
      files.catch(() => mcpStoreFiles.delete(sha256));
      mcpStoreFiles.set(sha256, files);
    }
    return await files;
  } catch {
    return empty;
  }
}

/** The labels of the required settings and credentials a row has not
 *  filled yet: the "needs setup" state. */
export function missingRequired(settings: unknown, config: unknown, storedSecrets: string[]): string[] {
  const fields = (settings as { fields?: unknown } | null)?.fields;
  if (!Array.isArray(fields)) return [];
  const values = (config ?? {}) as Record<string, unknown>;
  const missing: string[] = [];
  for (const f of fields as { name: string; kind: string; label?: string | null; required?: boolean }[]) {
    if (f.required !== true) continue;
    const value = values[f.name];
    const filled =
      f.kind === "secret"
        ? storedSecrets.includes(f.name)
        : f.kind === "boolean"
          ? typeof value === "boolean"
          : (typeof value === "string" && value !== "") || typeof value === "number";
    if (!filled) missing.push(f.label ?? f.name);
  }
  return missing;
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
          readme: connector.readme,
          tools: connector.tools.map((t) => ({ name: t.name, class: t.class, description: t.description })),
        },
        row,
        row === null ? [] : await gateway.integrationSecrets.names(orgId, connector.name),
      ),
    );
  }
  for (const builtin of BUILTIN_MCP) {
    const m = builtin.manifest;
    const auth = m["auth"] as { secret_names: string[] };
    const row = rowByName.get(builtin.name) ?? null;
    items.push(
      shopEntry(
        {
          name: builtin.name,
          title: m["title"] as string,
          version: m["version"] as string,
          publisher: m["publisher"] as string,
          summary: m["summary"] as string,
          description: m["description"] as string,
          docs_url: (m["docs_url"] as string | null) ?? null,
          logo: builtin.logo,
          categories: ["mcp", ...((m["categories"] as string[]) ?? [])],
          traits: {},
          secret_names: auth.secret_names,
          settings: m["settings"] ?? null,
          source: "builtin",
          readme: builtin.readme,
          tools: [],
        },
        row,
        row === null ? [] : await gateway.integrationSecrets.names(orgId, builtin.name),
      ),
    );
  }
  for (const item of await gateway.registry.listItems(orgId, "integration")) {
    if (item.review_status !== "approved" || builtinMcpByName(item.slug) !== undefined) continue;
    const manifest = await latestIntegrationManifest(gateway, orgId, item.slug);
    if (manifest === null || manifest["mcp"] === null || manifest["mcp"] === undefined) continue;
    const auth = (manifest["auth"] ?? null) as Record<string, unknown> | null;
    const secretNames = Array.isArray(auth?.["secret_names"]) ? (auth["secret_names"] as string[]) : [];
    const files = await mcpBundleFiles(gateway, orgId, item.slug);
    const declared = Array.isArray(manifest["categories"])
      ? (manifest["categories"] as unknown[]).filter((c): c is string => typeof c === "string" && c !== "mcp")
      : [];
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
          logo: typeof manifest["logo"] === "string" && manifest["logo"] !== "" ? (manifest["logo"] as string) : files.logo,
          categories: ["mcp", ...declared],
          traits: {},
          secret_names: secretNames,
          settings: manifest["settings"] ?? null,
          source: "mcp",
          readme:
            typeof manifest["readme"] === "string" && manifest["readme"] !== ""
              ? (manifest["readme"] as string)
              : files.readme,
          tools: [],
        },
        rowByName.get(item.slug) ?? null,
        rowByName.has(item.slug) ? await gateway.integrationSecrets.names(orgId, item.slug) : [],
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
    manifest = await requireApprovedManifest(gateway, orgId, integrationRow.name);
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
      mcpToolClass(rowConfig, manifest, t),
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
 *  URL when present; header templates must parse. */
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
    const declared = requiredSecretNames(registryManifestValue ?? {});
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

/** The settings-field labels of the named secrets, the name where a field
 *  has none. */
function secretLabels(manifest: Record<string, unknown>, names: string[]): string[] {
  const settings = manifest["settings"] as { fields?: { name?: unknown; label?: unknown }[] } | undefined;
  const fields = Array.isArray(settings?.fields) ? settings.fields : [];
  return names.map((n) => {
    const label = fields.find((f) => f.name === n)?.label;
    return typeof label === "string" && label !== "" ? label : n;
  });
}

/** Credentials and settings from an unsaved form, laid over the stored
 *  row for one connection test. */
export interface IntegrationTestDraft {
  config?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
}

/** Runs the integration's connection test against the stored config and
 *  secrets with the draft laid over them in memory; nothing is written.
 *  Draft config merges shallowly over the stored row for an MCP plugin and
 *  replaces it for a code plugin, as a save would; draft secrets override
 *  the stored ones of the same name. Throws the same errors a
 *  save would; resolves with the elapsed milliseconds. */
export async function testIntegration(
  gateway: IntegrationAdminDeps,
  orgId: string,
  name: string,
  existing: { config: unknown },
  draft: IntegrationTestDraft = {},
): Promise<number> {
  const started = Date.now();
  const stored = (existing.config ?? {}) as Record<string, unknown>;
  let secrets = await gateway.integrationSecrets.resolve(
    orgId,
    name,
    await gateway.integrationSecrets.names(orgId, name),
    gateway.masterKey(),
  );
  for (const [k, v] of Object.entries(draft.secrets ?? {})) {
    if (typeof v !== "string" || v === "") continue;
    secrets = secrets.filter(([n]) => n !== k);
    secrets.push([k, v]);
  }
  const manifest = await saveManifest(gateway, orgId, name);
  const isMcp = (manifest !== null && manifest["mcp"] != null) || readMcpUrl(stored) !== null;
  if (isMcp) {
    const config: Record<string, unknown> = { ...stored };
    for (const [k, v] of Object.entries(draft.config ?? {})) if (k !== "tools") config[k] = v;
    validateMcpConfig(config);
    const mcpUrl = readMcpUrl(config);
    if (mcpUrl === null) throw ApiError.badRequest("no MCP server URL is configured");
    const missing = requiredSecretNames(manifest ?? {}).filter((n) => !secrets.some(([s]) => s === n));
    if (missing.length > 0) {
      throw ApiError.conflict("missing_secrets", `missing secrets: ${secretLabels(manifest ?? {}, missing).join(", ")}`);
    }
    await mcpTestConnection(config, mcpUrl, secrets, orgId);
    return Date.now() - started;
  }
  const config = draft.config ?? stored;
  const connector = await connectorOrError(gateway, orgId, name);
  if (connector === undefined) throw ApiError.notFound(`unknown integration ${name}`);
  const missing = connector.fields
    .filter((f) => f.kind === "secret" && f.required && !secrets.some(([n]) => n === f.name))
    .map((f) => f.label ?? f.name);
  if (missing.length > 0) throw ApiError.conflict("missing_secrets", `missing secrets: ${missing.join(", ")}`);
  try {
    await connector.testConnection(config, secrets);
  } catch (error) {
    throw ApiError.badRequest((error as Error).message);
  }
  return Date.now() - started;
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
