// Admin API: user management, the
// assistant / approval-policy prompts (org_kv), and the integration
// configuration CRUD — including the save path (config validation, secret
// merge, connection tests) and the tools listing with per-tool curation
// (connector catalogs live in src/integrations/).

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GatewayCtx, IdentityCtx } from "../route-contexts.js";
import { ApiError } from "../errors.js";
import { parseUuidParam, requireJsonBody, requireAdminUser, sendJson, pathParam, optionalJsonBody } from "./error.js";
import { INTEGRATIONS, integrationByName } from "../integration-catalog.js";
import { isToolClass, manifestToolClass, toolClassOf } from "../domain/tool-class.js";
import { mcpConnect } from "../integrations/mcp.js";
import {
  envelopeHeaders,
  manifestSecretNames,
  namespacedTool,
  registryManifest,
  registryManifestIfApproved,
} from "../integrations/plugins.js";
import { toolCurate } from "../integrations/policy.js";
import { DEFAULT_APPROVAL_POLICY_PROMPT } from "../../harness/approvals.js";
import { DEFAULT_PERSONA } from "../../harness/extension.js";
import { APPROVAL_POLICY_PROMPT_KEY, ASSISTANT_PROMPT_KEY } from "../store/org_kv.js";
import { randomUUID } from "node:crypto";
/** Upper bound on a custom prompt — personas are short; this is abuse
 *  protection, not a context-window budget. */
const ASSISTANT_PROMPT_MAX = 10_000;

// ---------- users ----------

export function registerAdminUserRoutes(app: FastifyInstance, ctx: IdentityCtx): void {
  app.get("/api/v1/admin/users", async (req, reply) => {
    const admin = await requireAdminUser(ctx, req);
    const users = await ctx.identity.listUsers(admin.org_id);
    sendJson(reply, { users });
    return reply;
  });

  app.post("/api/v1/admin/users", async (req, reply) => {
    const admin = await requireAdminUser(ctx, req);
    const record = optionalJsonBody(req);
    const email = record["email"];
    if (typeof email !== "string") throw ApiError.badRequest("missing email");
    const password = record["password"];
    if (typeof password !== "string") throw ApiError.badRequest("missing password");
    ensureMinPasswordLen(password);
    const role = typeof record["role"] === "string" ? record["role"] : "member";
    if (role !== "admin" && role !== "member") {
      throw ApiError.badRequest("role must be admin or member");
    }
    const user = await ctx.identity.createUserManaged(admin.org_id, email, password, role);
    sendJson(reply, { id: user.id, email: user.email, role: user.role });
    return reply;
  });

  app.put("/api/v1/admin/users/:id", async (req, reply) => {
    const admin = await requireAdminUser(ctx, req);
    const userId = parseUuidParam(req, "id");
    const record = optionalJsonBody(req);
    let role: string | null = null;
    if (typeof record["role"] === "string" && record["role"] !== "") {
      if (record["role"] !== "admin" && record["role"] !== "member") {
        throw ApiError.badRequest("role must be admin or member");
      }
      role = record["role"];
    }
    let password: string | null = null;
    if (typeof record["password"] === "string" && record["password"] !== "") {
      password = record["password"];
      ensureMinPasswordLen(password);
    }
    if (role === null && password === null) {
      throw ApiError.badRequest("nothing to update");
    }
    // An admin must not demote themselves (the store also guards the org's
    // last admin).
    const target = await ctx.identity.getUser(userId);
    if (target.role === "admin" && role === "member" && target.id === admin.id) {
      throw ApiError.badRequest("cannot demote yourself");
    }
    const user = await ctx.identity.updateUser(admin.org_id, userId, role, password);
    sendJson(reply, { id: user.id, email: user.email, role: user.role });
    return reply;
  });

  app.delete("/api/v1/admin/users/:id", async (req, reply) => {
    const admin = await requireAdminUser(ctx, req);
    const userId = parseUuidParam(req, "id");
    if (userId === admin.id) {
      throw ApiError.badRequest("cannot delete yourself");
    }
    await ctx.identity.deleteUser(admin.org_id, userId);
    sendJson(reply, {});
    return reply;
  });
}

function ensureMinPasswordLen(password: string): void {
  if ([...password].length < 8) {
    throw ApiError.badRequest("password must be at least 8 characters");
  }
}

// ---------- org prompts (org_kv) ----------

export function registerAdminPromptRoutes(app: FastifyInstance, ctx: IdentityCtx): void {
  app.get("/api/v1/admin/assistant-prompt", async (req, reply) => {
    const admin = await requireAdminUser(ctx, req);
    const prompt = await ctx.orgKv.get(admin.org_id, ASSISTANT_PROMPT_KEY);
    sendJson(reply, { prompt, default: DEFAULT_PERSONA });
    return reply;
  });

  app.put("/api/v1/admin/assistant-prompt", async (req, reply) => {
    const admin = await requireAdminUser(ctx, req);
    await setOrgPrompt(ctx, admin.org_id, ASSISTANT_PROMPT_KEY, req);
    sendJson(reply, { ok: true });
    return reply;
  });

  app.get("/api/v1/admin/approval-policy-prompt", async (req, reply) => {
    const admin = await requireAdminUser(ctx, req);
    const prompt = await ctx.orgKv.get(admin.org_id, APPROVAL_POLICY_PROMPT_KEY);
    sendJson(reply, { prompt, default: DEFAULT_APPROVAL_POLICY_PROMPT });
    return reply;
  });

  app.put("/api/v1/admin/approval-policy-prompt", async (req, reply) => {
    const admin = await requireAdminUser(ctx, req);
    await setOrgPrompt(ctx, admin.org_id, APPROVAL_POLICY_PROMPT_KEY, req);
    sendJson(reply, { ok: true });
    return reply;
  });
}

/** Sets an org prompt. An empty string resets to the built-in default. */
async function setOrgPrompt(
  ctx: IdentityCtx,
  orgId: string,
  key: string,
  req: FastifyRequest,
): Promise<void> {
  const record = optionalJsonBody(req);
  const prompt = record["prompt"];
  if (typeof prompt !== "string") throw ApiError.badRequest('missing "prompt" string');
  if ([...prompt].length > ASSISTANT_PROMPT_MAX) {
    throw ApiError.badRequest("prompt exceeds 10,000 characters");
  }
  if (prompt === "") {
    await ctx.orgKv.delete(orgId, key);
  } else {
    await ctx.orgKv.put(orgId, key, prompt);
  }
}

// ---------- integrations (read paths + per-tool curation) ----------

/** Currently approved manifest of one registry integration item, if any.
 *  The approval covers only the bundle it hashed: a stored bundle that no
 *  longer matches reads as unapproved. */
async function latestIntegrationManifest(
  gateway: GatewayCtx,
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
  gateway: GatewayCtx,
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

export function registerAdminIntegrationRoutes(app: FastifyInstance, gateway: GatewayCtx, identity: IdentityCtx): void {
  // The integration shop: every installed plugin with its storefront
  // metadata and this org's install state, plus the approved registry v2
  // plugins. One list; the client filters and renders it.
  app.get("/api/v1/admin/integrations", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const rows = await gateway.integrations.list(admin.org_id);
    const items: Record<string, unknown>[] = [];
    const rowByName = new Map(rows.map((r) => [r.name, r]));
    for (const connector of INTEGRATIONS) {
      const row = rowByName.get(connector.name) ?? null;
      // A registry bundle of the same slug shadows the compiled-in kind.
      const manifest = row === null ? null : await latestIntegrationManifest(gateway, admin.org_id, connector.name);
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
          },
          row,
        ),
      );
    }
    for (const item of await gateway.registry.listItems(admin.org_id, "integration")) {
      if (item.review_status !== "approved") continue;
      const manifest = await latestIntegrationManifest(gateway, admin.org_id, item.slug);
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
          },
          rowByName.get(item.slug) ?? null,
        ),
      );
    }
    sendJson(reply, { items });
    return reply;
  });

  // Creates a configuration row for a not-yet-configured connector: a
  // compiled-in kind or an installed registry v2 MCP plugin. The new row's
  // stable id is the object's address from here on.
  app.post("/api/v1/admin/integrations", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const body = requireJsonBody(req);
    const name = body["name"];
    if (typeof name !== "string") throw ApiError.badRequest("missing name");
    const rows = await gateway.integrations.list(admin.org_id);
    if (rows.some((r) => r.name === name)) {
      throw ApiError.conflict("already_configured", `integration ${name} already has a configuration`);
    }
    // Known connectors only: a compiled-in kind, or an installed registry v2
    // bundle whose manifest declares an MCP server.
    const known =
      integrationByName(name) !== undefined ||
      (await latestIntegrationManifest(gateway, admin.org_id, name))?.["mcp"] != null;
    if (!known) throw ApiError.notFound(`unknown integration ${name}`);
    await saveIntegration(gateway, admin.org_id, name, null, body);
    const created = await gateway.integrations.getByName(admin.org_id, name);
    sendJson(reply, {
      id: created!.id,
      org_id: created!.org_id,
      name: created!.name,
      config: created!.config,
      enabled: created!.enabled,
    });
    return reply;
  });

  // Lists one integration's secret names, timestamps and masked previews —
  // never values.
  app.get("/api/v1/admin/integrations/:id/secrets", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const id = parseUuidParam(req, "id");
    const integrationRow = await gateway.integrations.get(admin.org_id, id);
    if (integrationRow === null) throw ApiError.notFound("unknown integration");
    const secrets = await gateway.integrationSecrets.list(admin.org_id, integrationRow.name, gateway.masterKey());
    sendJson(reply, { secrets });
    return reply;
  });

  // Sets one tool's per-tool curation (`enabled`, `approval`). Idempotent:
  // the stored config is the source of truth, so selections survive bundle
  // republishes and settings saves.
  app.put("/api/v1/admin/integrations/:id/tools/:tool", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const id = parseUuidParam(req, "id");
    const tool = pathParam(req, "tool");
    // The name becomes a JSON object key and a URL path segment: URL-safe
    // charset only, dashes and dots included (MCP tool names use them).
    if (tool === "" || ![...tool].every((c) => /[a-zA-Z0-9_.-]/.test(c))) {
      throw ApiError.badRequest("invalid tool name");
    }
    const record = optionalJsonBody(req);
    const enabled = record["enabled"];
    if (typeof enabled !== "boolean") throw ApiError.badRequest("enabled must be a boolean");
    const approval = typeof record["approval"] === "string" ? record["approval"] : "default";
    if (approval !== "default" && approval !== "always_ask" && approval !== "always_allow") {
      throw ApiError.badRequest("approval must be default, always_ask or always_allow");
    }
    const name = await gateway.integrations.curateTool(admin.org_id, id, tool, enabled, approval);
    // Durable, org-queryable audit of the governance change.
    await identity.events.emit(admin.org_id, "integration.tool_curated", {
      integration: name,
      tool,
      enabled,
      approval,
      by: admin.id,
    });
    sendJson(reply, { name: tool, enabled, approval });
    return reply;
  });

  // The full, unfiltered tool list of one integration row with each tool's
  // stored per-tool config. Built-in (adapter-bound) rows read their
  // compiled-in declarations; MCP rows connect live and merge the discovered
  // tools with the stored config. A disabled row reports `resolved: false`
  // without connecting; a broken plugin reports the resolution error — never
  // a silent empty list.
  app.get("/api/v1/admin/integrations/:id/tools", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const id = parseUuidParam(req, "id");
    const integrationRow = await gateway.integrations.get(admin.org_id, id);
    if (integrationRow === null) throw ApiError.notFound("unknown integration");
    const rowConfig = (integrationRow.config ?? {}) as Record<string, unknown>;
    const mcpUrl = readMcpUrl(rowConfig);
    if (mcpUrl === null) {
      const connector = integrationByName(integrationRow.name);
      if (connector === undefined) {
        throw ApiError.notFound(`unknown integration kind ${integrationRow.name}`);
      }
      let specs;
      try {
        specs = connector.toolSpecs(rowConfig);
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
      sendJson(reply, { resolved: true, kind: "builtin", tools });
      return reply;
    }
    // MCP-bound: live discovery merged with the stored config. A disabled
    // row is not resolved (it serves nothing); a reachable one lists every
    // tool it currently serves, each with the stored curation (absent =
    // disabled, so remote drift lands visible-but-off).
    if (!integrationRow.enabled) {
      sendJson(reply, { resolved: false, kind: "mcp", reason: "integration disabled", tools: [] });
      return reply;
    }
    let manifest: Record<string, unknown>;
    try {
      manifest = await registryManifest(gateway, admin.org_id, integrationRow.name);
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
      secrets = await gateway.integrationSecrets.resolve(admin.org_id, integrationRow.name, secretNames, gateway.masterKey());
    } catch (error) {
      throw ApiError.conflict("missing_secrets", (error as Error).message);
    }
    const headers = envelopeHeaders(randomUUID(), admin.org_id, null, null, secrets);
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
        manifestToolClass(manifest, t.name),
        t.description,
        true,
        rowConfig,
      ),
    );
    sendJson(reply, { resolved: true, kind: "mcp", tools });
    return reply;
  });

  // Removes an integration's configuration by id (the connector can be
  // re-added later as a fresh row with a fresh id).
  app.delete("/api/v1/admin/integrations/:id", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const id = parseUuidParam(req, "id");
    await gateway.integrations.delete(admin.org_id, id);
    sendJson(reply, {});
    return reply;
  });

  // Updates one integration by id: config, enabled flag and newly entered
  // credential values, validated and connection-tested before anything is
  // persisted. The connector slug comes from the row.
  app.put("/api/v1/admin/integrations/:id", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const id = parseUuidParam(req, "id");
    const body = requireJsonBody(req);
    const existing = await gateway.integrations.get(admin.org_id, id);
    if (existing === null) throw ApiError.notFound("unknown integration");
    await saveIntegration(gateway, admin.org_id, existing.name, existing, body);
    sendJson(reply, { ok: true });
    return reply;
  });
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
  url: string,
  secrets: [string, string][],
  orgId: string,
): Promise<void> {
  const headers = envelopeHeaders(randomUUID(), orgId, null, null, secrets);
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
async function saveIntegration(
  gateway: GatewayCtx,
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
        ? { mcp: manifest["mcp"], auth: manifest["auth"] ?? { kind: "org_secret", secret_names: [], identity_key: "email" }, tool_policy: {} }
        : {};
    await gateway.integrations.upsert(orgId, name, config, false);
    return;
  }
  const registryManifestValue = await saveManifest(gateway, orgId, name);
  const v2Claimed =
    (registryManifestValue !== null && registryManifestValue["mcp"] != null) ||
    readMcpUrl(existingConfig) !== null;
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
    const enabled =
      typeof body["enabled"] === "boolean" ? body["enabled"] : (existing?.enabled ?? false);
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
        await mcpTestConnection(readMcpUrl(config) ?? "", secrets, orgId);
      }
    }
    for (const [k, v] of submitted) {
      await gateway.integrationSecrets.upsert(orgId, name, k, v, master);
    }
    await gateway.integrations.upsert(orgId, name, config, enabled);
    return;
  }
  const connector = integrationByName(name);
  if (connector === undefined) throw ApiError.notFound(`unknown integration ${name}`);
  let config = body["config"] !== undefined ? body["config"] : existing?.config ?? {};
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
    connector.toolSpecs(configForTools);
  } catch (error) {
    throw ApiError.badRequest(`invalid integration config: ${(error as Error).message}`);
  }
  const schemaFields = INTEGRATIONS.find((c) => c.name === name)!.fields;
  const enabled =
    typeof body["enabled"] === "boolean" ? body["enabled"] : (existing?.enabled ?? false);
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
  for (const [k, v] of submitted) {
    await gateway.integrationSecrets.upsert(orgId, name, k, v, master);
  }
  await gateway.integrations.upsert(orgId, name, config, enabled);
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
