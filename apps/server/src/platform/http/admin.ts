// Admin API (crates/server/src/http/admin.rs): user management, the
// assistant / approval-policy prompts (org_kv), and the integration
// configuration read paths + per-tool curation. The integration save path
// (POST/PUT with config validation, connection tests and live MCP
// discovery) and the tools listing stay on the Rust side for now — see the
// M6 report for the disposition.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { PlatformContext } from "../context.js";
import { ApiError, parseUuidParam, requireUser } from "./error.js";
import { rustJsonText } from "../provider/sse.js";
import { CONNECTORS, connectorByName, type ConnectorManifest } from "../integration-catalog.js";

/** Org KV key holding the admin-configured assistant persona prompt. */
const ASSISTANT_PROMPT_KEY = "assistant_system_prompt";
/** Org KV key holding the admin-configured "Approve for me" policy prompt. */
const APPROVAL_POLICY_PROMPT_KEY = "assistant_approval_policy_prompt";
/** Upper bound on a custom prompt — personas are short; this is abuse
 *  protection, not a context-window budget. */
const ASSISTANT_PROMPT_MAX = 10_000;

/** The built-in "Approve for me" auto-approval policy prompt (crates/
 *  server/src/worker/restate.rs DEFAULT_APPROVAL_POLICY_PROMPT). */
const DEFAULT_APPROVAL_POLICY_PROMPT =
  "You are the safety gate for an AI assistant that runs tools on the user's machine. You are given one proposed tool action as JSON. Decide whether it is safe to run automatically, without asking the user first.\n\n" +
  "Approve routine, low-risk actions: reading files, ordinary read-only shell commands (ls, dir, cat, git status, git log, ping, date), writing or editing files inside the user's workspace, web searches, and fetching public URLs.\n\n" +
  "Ask the user when the action is potentially unsafe: destructive or irreversible operations (deleting files or data, force-pushing, dropping or truncating databases, factory resets), anything touching files outside the workspace or system locations, installing or upgrading software, killing processes or services, sending credentials or secrets anywhere, spending money, sending messages or email on the user's behalf, or anything unusual for a coding assistant.\n\n" +
  'Reply with ONLY a JSON object, no other text: {"approve": true, "reason": "one short sentence"} where approve=true means run it silently and approve=false means the user must be asked first.';

function sendJson(reply: FastifyReply, value: unknown): void {
  void reply.type("application/json").send(rustJsonText(value));
}

function jsonRecord(body: unknown): Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

async function requireAdmin(ctx: PlatformContext, req: FastifyRequest) {
  const user = await requireUser(ctx, req);
  if (user.role !== "admin") throw ApiError.forbidden();
  return user;
}

// ---------- users ----------

export function registerAdminUserRoutes(app: FastifyInstance, ctx: PlatformContext): void {
  app.get("/api/v1/admin/users", async (req, reply) => {
    const admin = await requireAdmin(ctx, req);
    const users = await ctx.identity.listUsers(admin.org_id);
    sendJson(reply, { users });
    return reply;
  });

  app.post("/api/v1/admin/users", async (req, reply) => {
    const admin = await requireAdmin(ctx, req);
    const record = jsonRecord(req.body);
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
    const admin = await requireAdmin(ctx, req);
    const userId = parseUuidParam(req, "id");
    const record = jsonRecord(req.body);
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
    const admin = await requireAdmin(ctx, req);
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

export function registerAdminPromptRoutes(app: FastifyInstance, ctx: PlatformContext): void {
  app.get("/api/v1/admin/assistant-prompt", async (req, reply) => {
    const admin = await requireAdmin(ctx, req);
    const prompt = await ctx.orgKv.get(admin.org_id, ASSISTANT_PROMPT_KEY);
    sendJson(reply, { prompt });
    return reply;
  });

  app.put("/api/v1/admin/assistant-prompt", async (req, reply) => {
    const admin = await requireAdmin(ctx, req);
    await setOrgPrompt(ctx, admin.org_id, ASSISTANT_PROMPT_KEY, req);
    sendJson(reply, { ok: true });
    return reply;
  });

  app.get("/api/v1/admin/approval-policy-prompt", async (req, reply) => {
    const admin = await requireAdmin(ctx, req);
    const prompt = await ctx.orgKv.get(admin.org_id, APPROVAL_POLICY_PROMPT_KEY);
    sendJson(reply, { prompt, default: DEFAULT_APPROVAL_POLICY_PROMPT });
    return reply;
  });

  app.put("/api/v1/admin/approval-policy-prompt", async (req, reply) => {
    const admin = await requireAdmin(ctx, req);
    await setOrgPrompt(ctx, admin.org_id, APPROVAL_POLICY_PROMPT_KEY, req);
    sendJson(reply, { ok: true });
    return reply;
  });
}

/** Sets an org prompt. An empty string resets to the built-in default. */
async function setOrgPrompt(
  ctx: PlatformContext,
  orgId: string,
  key: string,
  req: FastifyRequest,
): Promise<void> {
  const record = jsonRecord(req.body);
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

/** The schema/secret/categories metadata one connector contributes to the
 *  admin list (both as a configured row and in the available list). */
function connectorMetadata(m: ConnectorManifest): {
  categories: string[];
  secret_names: string[];
  settings: unknown;
} {
  return {
    categories: m.categories,
    secret_names: m.secret_names,
    settings: m.fields.length > 0 ? { fields: m.fields } : null,
  };
}

/** Currently approved manifest of one registry integration item, if any. */
async function latestIntegrationManifest(
  ctx: PlatformContext,
  orgId: string,
  slug: string,
): Promise<Record<string, unknown> | null> {
  const approved = await ctx.registry.approvedBundle(orgId, "integration", slug);
  if (approved === null) return null;
  const stored = await ctx.registry.getVersion(orgId, "integration", slug, approved[0]);
  const manifest = stored.manifest;
  return manifest !== null && typeof manifest === "object" && !Array.isArray(manifest)
    ? (manifest as Record<string, unknown>)
    : null;
}

export function registerAdminIntegrationRoutes(app: FastifyInstance, ctx: PlatformContext): void {
  // Lists this org's integration plugins (configured and unconfigured).
  // `available` holds the compiled-in kinds plus approved registry v2
  // plugins that have no configured row yet.
  app.get("/api/v1/admin/integrations", async (req, reply) => {
    const admin = await requireAdmin(ctx, req);
    const rows = await ctx.integrations.list(admin.org_id);
    const rowValues: unknown[] = [];
    for (const row of rows) {
      const rowConfig = (row.config ?? {}) as Record<string, unknown>;
      const mcpUrl = readMcpUrl(rowConfig);
      const manifest = await latestIntegrationManifest(ctx, admin.org_id, row.name);
      const mcpClaimed = (manifest !== null && manifest["mcp"] !== null && manifest["mcp"] !== undefined) || mcpUrl !== null;
      // A compiled-in kind reports its own categories; a registry v2 MCP
      // plugin shadows the compiled-in kind of the same slug.
      const categories = mcpClaimed ? ["mcp"] : connectorByName(row.name)?.categories ?? ["other"];
      const secretNames = mcpClaimed
        ? declaredV2SecretNames(manifest)
        : connectorByName(row.name)?.secret_names ?? [];
      const settings = mcpClaimed ? (manifest?.["settings"] ?? null) : connectorMetadataFor(row.name)?.settings ?? null;
      rowValues.push({
        id: row.id,
        org_id: row.org_id,
        name: row.name,
        config: row.config ?? {},
        enabled: row.enabled,
        categories,
        secret_names: secretNames,
        settings,
      });
    }
    const available: unknown[] = [];
    for (const connector of CONNECTORS) {
      // A compiled-in kind with an existing row is configured — it leaves
      // the available list (an installed registry bundle of the same slug
      // shadows it).
      if (rows.some((r) => r.name === connector.name)) continue;
      available.push({
        name: connector.name,
        categories: connector.categories,
        secret_names: connector.secret_names,
        settings: connectorMetadata(connector).settings,
      });
    }
    for (const item of await ctx.registry.listItems(admin.org_id, "integration")) {
      if (item.review_status !== "approved" || rows.some((r) => r.name === item.slug)) continue;
      const manifest = await latestIntegrationManifest(ctx, admin.org_id, item.slug);
      if (manifest === null || manifest["mcp"] === null || manifest["mcp"] === undefined) continue;
      const auth = (manifest["auth"] ?? null) as Record<string, unknown> | null;
      const secretNames = Array.isArray(auth?.["secret_names"]) ? (auth?.["secret_names"] as string[]) : [];
      available.push({
        name: item.slug,
        categories: ["mcp"],
        secret_names: secretNames,
        settings: manifest["settings"] ?? null,
      });
    }
    sendJson(reply, { integrations: rowValues, available });
    return reply;
  });

  // Lists one integration's secret names, timestamps and masked previews —
  // never values.
  app.get("/api/v1/admin/integrations/:id/secrets", async (req, reply) => {
    const admin = await requireAdmin(ctx, req);
    const id = parseUuidParam(req, "id");
    const integrationRow = await ctx.integrations.get(admin.org_id, id);
    if (integrationRow === null) throw ApiError.notFound("unknown integration");
    const secrets = await ctx.integrationSecrets.list(admin.org_id, integrationRow.name, ctx.masterKey());
    sendJson(reply, { secrets });
    return reply;
  });

  // Sets one tool's per-tool curation (`enabled`, `approval`). Idempotent:
  // the stored config is the source of truth, so selections survive bundle
  // republishes and settings saves.
  app.put("/api/v1/admin/integrations/:id/tools/:tool", async (req, reply) => {
    const admin = await requireAdmin(ctx, req);
    const id = parseUuidParam(req, "id");
    const tool = param(req, "tool");
    // The name becomes a JSON object key and a URL path segment: URL-safe
    // charset only, dashes and dots included (MCP tool names use them).
    if (tool === "" || ![...tool].every((c) => /[a-zA-Z0-9_.-]/.test(c))) {
      throw ApiError.badRequest("invalid tool name");
    }
    const record = jsonRecord(req.body);
    const enabled = record["enabled"];
    if (typeof enabled !== "boolean") throw ApiError.badRequest("enabled must be a boolean");
    const approval = typeof record["approval"] === "string" ? record["approval"] : "default";
    if (approval !== "default" && approval !== "always_ask") {
      throw ApiError.badRequest("approval must be default or always_ask");
    }
    // Read-modify-write under a row lock in one transaction: two concurrent
    // PUTs (or a racing settings save) must never drop each other's
    // curation entry. Entries for not-currently-declared tools are allowed
    // — they are how a preset survives a bundle republish.
    const client = await ctx.pool.connect();
    let name: string;
    try {
      await client.query("BEGIN");
      const rowRes = await client.query(
        "SELECT config, name FROM integrations WHERE org_id = $1 AND id = $2 FOR UPDATE",
        [admin.org_id, id],
      );
      const stored = rowRes.rows[0];
      if (stored === undefined) throw ApiError.notFound("unknown integration");
      name = stored.name as string;
      const config =
        stored.config !== null && typeof stored.config === "object" && !Array.isArray(stored.config)
          ? { ...(stored.config as Record<string, unknown>) }
          : {};
      const tools =
        config["tools"] !== null && typeof config["tools"] === "object" && !Array.isArray(config["tools"])
          ? { ...(config["tools"] as Record<string, unknown>) }
          : {};
      tools[tool] = { enabled, approval };
      config["tools"] = tools;
      await client.query(
        "UPDATE integrations SET config = $2, updated_at = now() WHERE org_id = $1 AND id = $3",
        [admin.org_id, JSON.stringify(config), id],
      );
      await client.query("COMMIT");
      // Durable, org-queryable audit of the governance change.
      await ctx.events.emit(admin.org_id, "integration.tool_curated", {
        integration: name,
        tool,
        enabled,
        approval,
        by: admin.id,
      });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    sendJson(reply, { name: tool, enabled, approval });
    return reply;
  });

  // Removes an integration's configuration by id (the connector can be
  // re-added later as a fresh row with a fresh id).
  app.delete("/api/v1/admin/integrations/:id", async (req, reply) => {
    const admin = await requireAdmin(ctx, req);
    const id = parseUuidParam(req, "id");
    await ctx.integrations.delete(admin.org_id, id);
    sendJson(reply, {});
    return reply;
  });
}

function connectorMetadataFor(name: string): { settings: unknown } | null {
  const connector = connectorByName(name);
  return connector === undefined ? null : { settings: connectorMetadata(connector).settings };
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

/** Secret names a v2 MCP manifest declares: the settings schema's
 *  secret-kind fields when it yields any, else the auth block's list. */
function declaredV2SecretNames(manifest: Record<string, unknown> | null): string[] {
  if (manifest === null) return [];
  const settings = manifest["settings"];
  if (settings !== null && typeof settings === "object" && Array.isArray((settings as Record<string, unknown>)["fields"])) {
    const derived = ((settings as Record<string, unknown>)["fields"] as Record<string, unknown>[])
      .filter((f) => f["kind"] === "secret" && typeof f["name"] === "string")
      .map((f) => f["name"] as string);
    if (derived.length > 0) return derived;
  }
  const auth = manifest["auth"];
  if (auth !== null && typeof auth === "object" && Array.isArray((auth as Record<string, unknown>)["secret_names"])) {
    return (auth as Record<string, unknown>)["secret_names"] as string[];
  }
  return [];
}

function param(req: FastifyRequest, name: string): string {
  return (req.params as Record<string, string>)[name] ?? "";
}
