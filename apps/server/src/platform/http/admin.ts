// Admin API: user management, the assistant / approval-policy prompts
// (org_kv), and the integration configuration routes. The integration
// logic (shop, save, tools) is the integrations admin service
// (src/integrations/admin.ts).

import { IntegrationAccessStore } from "../store/integration-access.js";
import { agentWarnings, isAudience, isGrantCeiling } from "../domain/integration-access.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GatewayCtx, IdentityCtx } from "../route-contexts.js";
import { ApiError } from "../errors.js";
import {
  parseUuidParam,
  requireJsonBody,
  requireAdminUser,
  sendJson,
  pathParam,
  optionalJsonBody,
  queryParam,
} from "./error.js";
import {
  createIntegration,
  integrationShop,
  integrationTools,
  saveIntegration,
  testIntegration,
  type IntegrationTestDraft,
} from "../../integrations/admin.js";
import { clampDays, integrationUsage, usageSummary } from "../store/integration-usage.js";
import { createOrgMcp, probeOrgMcp } from "../../integrations/org-mcp.js";
import { isToolClass } from "../domain/tool-class.js";
import type { ObjectStore } from "../s3.js";
import { DEFAULT_APPROVAL_POLICY_PROMPT } from "../../harness/approvals.js";
import { defaultPersona } from "../../harness/extension.js";
import { APPROVAL_POLICY_PROMPT_KEY, ASSISTANT_PROMPT_KEY } from "../store/org-kv.js";
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
    const org = await ctx.orgs.get(admin.org_id);
    sendJson(reply, { prompt, default: defaultPersona(org.name) });
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
async function setOrgPrompt(ctx: IdentityCtx, orgId: string, key: string, req: FastifyRequest): Promise<void> {
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

export function registerAdminIntegrationRoutes(
  app: FastifyInstance,
  gateway: GatewayCtx,
  identity: IdentityCtx,
  objects: ObjectStore,
): void {
  // The integration shop: every installed plugin with its storefront
  // metadata and this org's install state, plus the approved registry v2
  // plugins. One list; the client filters and renders it.
  app.get("/api/v1/admin/integrations", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const items = await integrationShop(gateway, admin.org_id);
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
    await createIntegration(gateway, admin.org_id, name, body);
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

  // Org MCP servers: the probe connects with the would-be URL and headers
  // and lists the tools with a suggested class; the create publishes and
  // approves the manifest and stores the enabled row in one step.
  app.post("/api/v1/admin/integrations/mcp/probe", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const tools = await probeOrgMcp(admin.org_id, requireJsonBody(req));
    sendJson(reply, { tools });
    return reply;
  });

  app.post("/api/v1/admin/integrations/mcp", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const slug = await createOrgMcp(
      {
        integrations: gateway.integrations,
        integrationSecrets: gateway.integrationSecrets,
        registry: gateway.registry,
        teams: identity.teams,
        events: identity.events,
        objects,
        masterKey: () => gateway.masterKey(),
      },
      {
        orgId: admin.org_id,
        userId: admin.id,
        role: admin.role,
        label: admin.display_name && admin.display_name !== "" ? admin.display_name : admin.email,
      },
      requireJsonBody(req),
    );
    const created = await gateway.integrations.getByName(admin.org_id, slug);
    sendJson(reply, { id: created!.id, name: created!.name });
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
    // An MCP tool's class is the admin's call (a compiled-in tool's class
    // is its code declaration).
    let cls: string | null = null;
    if (record["class"] !== undefined) {
      if (!isToolClass(record["class"])) throw ApiError.badRequest("class must be read, write or admin");
      const row = await gateway.integrations.get(admin.org_id, id);
      if (row === null) throw ApiError.notFound("unknown integration");
      const mcp = (row.config as Record<string, unknown> | null)?.["mcp"];
      if (mcp === null || typeof mcp !== "object") {
        throw ApiError.badRequest("only an MCP integration's tool classes can be changed");
      }
      cls = record["class"];
    }
    const name = await gateway.integrations.curateTool(admin.org_id, id, tool, enabled, approval, cls);
    // Durable, org-queryable audit of the governance change.
    await identity.events.emit(admin.org_id, "integration.tool_curated", {
      integration: name,
      tool,
      enabled,
      approval,
      ...(cls !== null ? { class: cls } : {}),
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
    sendJson(reply, await integrationTools(gateway, admin.org_id, id));
    return reply;
  });

  // Runs the connection test against the stored config and secrets, with
  // an unsaved form's { config, secrets } laid over them; nothing is
  // written. A failed test is the answer, not a request error:
  // { ok: false, error }.
  app.post("/api/v1/admin/integrations/:id/test", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const id = parseUuidParam(req, "id");
    const existing = await gateway.integrations.get(admin.org_id, id);
    if (existing === null) throw ApiError.notFound("unknown integration");
    try {
      const body = optionalJsonBody(req);
      const draft: IntegrationTestDraft = {};
      const isObject = (v: unknown): v is Record<string, unknown> =>
        v !== null && typeof v === "object" && !Array.isArray(v);
      if (isObject(body["config"])) draft.config = body["config"];
      if (isObject(body["secrets"])) draft.secrets = body["secrets"];
      const ms = await testIntegration(gateway, admin.org_id, existing.name, existing, draft);
      sendJson(reply, { ok: true, ms });
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
      sendJson(reply, { ok: false, error: error.message });
    }
    return reply;
  });

  // Calls, failures and last-call state per integration over the window
  // (?days=, default 7): the installed list's status and counts.
  app.get("/api/v1/admin/integrations/usage", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const days = clampDays(queryParam(req, "days"), 7);
    sendJson(reply, { days, items: await usageSummary(identity.events.pool, admin.org_id, days) });
    return reply;
  });

  // One integration's usage over the window (?days=, default 30).
  app.get("/api/v1/admin/integrations/:id/usage", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const id = parseUuidParam(req, "id");
    const existing = await gateway.integrations.get(admin.org_id, id);
    if (existing === null) throw ApiError.notFound("unknown integration");
    const days = clampDays(queryParam(req, "days"), 30);
    sendJson(reply, await integrationUsage(identity.events.pool, admin.org_id, existing.name, days));
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

  // An Integration's audience: who may add it to an agent, and up to which
  // class; plus every agent that lists it, with the warnings where that
  // agent's audience is wider.
  const access = new IntegrationAccessStore(gateway.integrations.pool);
  const accessView = async (orgId: string, id: string): Promise<Record<string, unknown>> => {
    const [audience, context, agents] = await Promise.all([
      access.audienceById(orgId, id),
      access.context(orgId),
      access.agentsUsing(orgId, id),
    ]);
    return {
      audience: audience.audience,
      org_ceiling: audience.org_ceiling,
      grants: audience.grants,
      teams: [...context.teams]
        .map(([teamId, name]) => ({ id: teamId, name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      agents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        status: agent.status,
        owner_label: agent.owner_label,
        visibility: agent.visibility,
        is_personal: agent.is_personal,
        ceiling: agent.integrations[0]?.ceiling ?? "read",
        warnings: agentWarnings(agent, context),
      })),
    };
  };

  app.get("/api/v1/admin/integrations/:id/access", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    sendJson(reply, await accessView(admin.org_id, parseUuidParam(req, "id")));
    return reply;
  });

  app.put("/api/v1/admin/integrations/:id/access", async (req, reply) => {
    const admin = await requireAdminUser(identity, req);
    const id = parseUuidParam(req, "id");
    const body = requireJsonBody(req);
    const audience = body["audience"];
    if (!isAudience(audience)) throw ApiError.badRequest("audience must be org, team or admins");
    const orgCeiling = body["org_ceiling"] ?? "read";
    if (!isGrantCeiling(orgCeiling)) throw ApiError.badRequest("org_ceiling must be read or write");
    const rawGrants = body["grants"] ?? [];
    if (!Array.isArray(rawGrants)) throw ApiError.badRequest("grants must be an array");
    const grants = rawGrants.map((item: unknown) => {
      const grant = item as Record<string, unknown> | null;
      if (grant === null || typeof grant !== "object" || typeof grant["team_id"] !== "string") {
        throw ApiError.badRequest("each grant needs a team_id");
      }
      if (!isGrantCeiling(grant["ceiling"])) throw ApiError.badRequest("a grant's ceiling must be read or write");
      return { team_id: grant["team_id"], ceiling: grant["ceiling"] };
    });
    if (audience === "team" && grants.length === 0) throw ApiError.badRequest("a team audience needs a team");
    await access.setAudience(admin.org_id, id, audience, orgCeiling, audience === "team" ? grants : []);
    const row = await gateway.integrations.get(admin.org_id, id);
    await identity.events.emit(admin.org_id, "integration.access_changed", {
      slug: row?.name ?? null,
      by: admin.id,
      audience,
      org_ceiling: orgCeiling,
      grants: audience === "team" ? grants : [],
    });
    sendJson(reply, await accessView(admin.org_id, id));
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
