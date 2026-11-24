// Script-facing integration tool API: the same policy-filtered plugin
// tools the chat loop uses — built-in and MCP plugins alike — reachable
// over HTTPS so scripts can call them with session or org-API-key auth.
// The execute route dispatches through the connector runtime
// (src/integrations/execute.ts): a connector failure is a result (HTTP
// 200, ok:false), never an HTTP error.

import type { FastifyInstance, FastifyRequest } from "fastify";
import type { GatewayCtx, IdentityCtx } from "../route-contexts.js";
import { ApiError } from "../errors.js";
import { resolveActingAs, scopeCeiling, toolOffered, type IntegrationScope } from "../../integrations/policy.js";
import { IntegrationAccessStore } from "../store/integration-access.js";
import { sendJson } from "./error.js";
import type { JsonObject } from "../../integrations/shared.js";
import type { IntegrationTurn } from "../../integrations/plugins.js";
import {
  callerScope,
  memberTool,
  runMemberTool,
  turns,
  type IntegrationCaller,
} from "../../integrations/member-tools.js";

export type { IntegrationCaller };

async function integrationCaller(auth: IdentityCtx, req: FastifyRequest): Promise<IntegrationCaller> {
  const header = req.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : null;
  if (token === null) throw ApiError.unauthorized("missing authorization header");
  // Session first (member or admin), then org API key.
  try {
    const user = await auth.identity.validateSession(token);
    return { org: user.org_id, userId: user.id, email: user.email, role: user.role };
  } catch {
    // fall through to the API key
  }
  const key = await auth.apiKeys.authenticate(token);
  if (key === null) throw ApiError.unauthorized("invalid credentials");
  let role = "member";
  try {
    role = (await auth.identity.getUser(key.created_by)).role;
  } catch {
    role = "member";
  }
  // The key's owner is the acting principal: the email is loaded, not left
  // unset — an unmapped caller would otherwise fall through to the
  // connectors' admin/default subject and read another person's mailbox,
  // Drive, calendar.
  const owner = key.user_id ?? key.created_by;
  let email: string | null = null;
  try {
    email = (await auth.identity.getUser(owner)).email;
  } catch {
    email = null;
  }
  return { org: key.org_id, userId: owner, email, role };
}

export function registerIntegrationToolRoutes(app: FastifyInstance, auth: IdentityCtx, gateway: GatewayCtx): void {
  const access = new IntegrationAccessStore(gateway.integrations.pool);
  const allowed = (
    scope: IntegrationScope,
    caller: IntegrationCaller,
    turn: IntegrationTurn,
    info: IntegrationTurn["tools"][number],
  ) => toolOffered(turn, info, scopeCeiling(scope, turn.slug, info), caller.role);
  // `GET /api/v1/integrations` — enabled plugins (built-in and MCP) for the
  // caller's org, policy-filtered to a count only.
  app.get("/api/v1/integrations", async (req, reply) => {
    const caller = await integrationCaller(auth, req);
    const scope = await callerScope(access, caller);
    const items = (await turns(gateway, caller.org)).map((t) => ({
      slug: t.slug,
      description: t.description,
      tool_count: t.tools.filter((info) => allowed(scope, caller, t, info)).length,
    }));
    sendJson(reply, { items });
    return reply;
  });

  // `GET /api/v1/integrations/{slug}/tools` — the full policy-filtered tool
  // list with JSON schemas and classes.
  app.get("/api/v1/integrations/:slug/tools", async (req, reply) => {
    const caller = await integrationCaller(auth, req);
    const slug = (req.params as Record<string, string>)["slug"] ?? "";
    const turn = (await turns(gateway, caller.org)).find((t) => t.slug === slug);
    if (turn === undefined) throw ApiError.notFound("no such integration");
    const scope = await callerScope(access, caller);
    const tools = turn.tools
      .filter((info) => allowed(scope, caller, turn, info))
      .map((info) => ({
        name: info.spec.name,
        description: info.spec.description,
        parameters: info.spec.parameters,
        class: info.class,
      }));
    sendJson(reply, { tools });
    return reply;
  });

  // `POST /api/v1/integrations/{slug}/tools/{tool}` — executes one tool with
  // the identity envelope; the body is the JSON arguments object. A
  // connector failure is a 200 ok:false result.
  app.post("/api/v1/integrations/:slug/tools/:tool", async (req, reply) => {
    const caller = await integrationCaller(auth, req);
    const params = req.params as Record<string, string>;
    const slug = params["slug"] ?? "";
    const tool = params["tool"] ?? "";
    const { turn, raw, alwaysAsk } = await memberTool(gateway, access, caller, slug, tool);
    // The script API is non-interactive: a tool curated to always_ask has no
    // durable card to resolve here, so it is refused rather than silently
    // bypassing the approval (the stored per-tool config is the single
    // source of truth for exposure and approval).
    if (alwaysAsk) {
      throw ApiError.forbidden("this tool needs an approval and cannot be called from a script");
    }
    // Identity: acting as the caller's own mapped identity; an override to
    // another member's identity is admin-only.
    const overrideHeader = req.headers["x-guild-acting-as"];
    const override = typeof overrideHeader === "string" && overrideHeader !== "" ? overrideHeader : null;
    const isAdmin = caller.role === "admin";
    let actingAs: string | null;
    try {
      actingAs = resolveActingAs(caller.email, override, isAdmin);
    } catch {
      throw ApiError.forbidden("acting as another member is admin-only");
    }
    // The body is the JSON arguments object (empty body = {}); any JSON
    // value that is not an object is refused.
    // The body arrives as the route scope's raw buffer for unknown content
    // types, and as the platform parser's already-parsed JSON value for
    // application/json — both shapes carry the arguments object.
    const rawBody: unknown = req.body;
    let args: unknown = {};
    if (rawBody !== undefined && rawBody !== null) {
      const text = typeof rawBody === "string" ? rawBody : Buffer.isBuffer(rawBody) ? rawBody.toString("utf8") : null;
      if (text === null) {
        args = rawBody;
      } else if (text.length > 0) {
        try {
          args = JSON.parse(text);
        } catch {
          throw ApiError.badRequest("body must be a JSON object");
        }
      }
    }
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      throw ApiError.badRequest("body must be a JSON object");
    }
    const body = await runMemberTool(gateway, auth.events, caller, turn, raw, args as JsonObject, actingAs, {
      via: "script",
    });
    sendJson(reply, body);
    return reply;
  });
}
