// Script-facing integration tool API (crates/server/src/http/
// integration_tools.rs): the same policy-filtered plugin tools the chat loop
// uses — built-in and MCP plugins alike — reachable over HTTPS so scripts
// can call them with session or org-API-key auth.
//
// The tool RUNTIME (execute) is not ported (spec decision 8 defers the
// integrations runtime): the execute route authenticates and validates
// identically, then fails the way the Rust connector fails with its backend
// unreachable — HTTP 200 with `{"ok": false, "error": "…"}` (a connector
// failure is a result, not an HTTP error). The error text names the slug as
// unreachable; the validation-only prefix of the call (auth, curation,
// acting-as, body shape) never reaches that point unless it passed.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { GatewayCtx, IdentityCtx } from "../contexts.js";
import { ApiError } from "../errors.js";
import { rustJsonText } from "../provider/sse.js";
import {
  resolveActingAs,
  resolvePlugins,
  toolAllowed,
  toolCurate,
  unnamespacedTool,
  type PluginTurn,
} from "../integrations/plugins.js";

/** The caller of the script API: an org member (session) or an org API key.
 *  API keys act with their creating user's role (usage attributes the same
 *  way); their acting identity is null unless declared. */
export interface IntegrationCaller {
  org: string;
  userId: string;
  email: string | null;
  role: string;
}

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

function sendJson(reply: FastifyReply, value: unknown): void {
  void reply.type("application/json").send(rustJsonText(value));
}

async function turns(gateway: GatewayCtx, orgId: string): Promise<PluginTurn[]> {
  try {
    return await resolvePlugins(gateway, orgId);
  } catch {
    // The resolved plugins of the caller's org — a broken plugin contributes
    // nothing (spec §8).
    return [];
  }
}

export function registerIntegrationToolRoutes(app: FastifyInstance, auth: IdentityCtx, gateway: GatewayCtx): void {  // `GET /api/v1/integrations` — enabled plugins (built-in and MCP) for the
  // caller's org, policy-filtered to a count only.
  app.get("/api/v1/integrations", async (req, reply) => {
    const caller = await integrationCaller(auth, req);
    const items = (await turns(gateway, caller.org)).map((t) => ({
      slug: t.slug,
      description: t.description,
      tool_count: t.tools.filter((info) => toolAllowed(t, info, caller.role)).length,
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
    const tools = turn.tools
      .filter((info) => toolAllowed(turn, info, caller.role))
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
  // the identity envelope; the body is the JSON arguments object. Auth and
  // validation match the Rust route exactly; the call then fails like the
  // Rust connector with its backend unreachable (200, ok:false) — the
  // integrations runtime is deferred (spec decision 8).
  app.post("/api/v1/integrations/:slug/tools/:tool", async (req, reply) => {
    const caller = await integrationCaller(auth, req);
    const params = req.params as Record<string, string>;
    const slug = params["slug"] ?? "";
    const tool = params["tool"] ?? "";
    const turn = (await turns(gateway, caller.org)).find((t) => t.slug === slug);
    if (turn === undefined) throw ApiError.notFound("no such integration");
    // The path carries the Guild-facing namespaced name; the raw connector
    // name is accepted too — both sides are compared after namespace
    // stripping (legacy int_ prefix tolerated) so either shape matches.
    const info = turn.tools.find((i) => {
      const callRaw = unnamespacedTool(turn.slug, tool) ?? tool;
      const specRaw = unnamespacedTool(turn.slug, i.spec.name) ?? i.spec.name;
      return callRaw === specRaw;
    });
    if (info === undefined) throw ApiError.notFound("no such tool");
    if (!toolAllowed(turn, info, caller.role)) throw ApiError.forbidden();
    // The script API is non-interactive: a tool curated to always_ask has no
    // durable card to resolve here, so it is refused rather than silently
    // bypassing the approval (the stored per-tool config is the single
    // source of truth for exposure and approval).
    const raw = unnamespacedTool(turn.slug, info.spec.name) ?? info.spec.name;
    if (toolCurate(turn.rowConfig, turn.executor === "mcp", raw).alwaysAsk) {
      throw ApiError.forbidden();
    }
    // Identity: acting as the caller's own mapped identity; an override to
    // another member's identity is admin-only.
    const overrideHeader = req.headers["x-guild-acting-as"];
    const override = typeof overrideHeader === "string" && overrideHeader !== "" ? overrideHeader : null;
    const isAdmin = caller.role === "admin" || caller.role === "owner";
    let actingAs: string | null;
    try {
      actingAs = resolveActingAs(caller.email, override, isAdmin);
    } catch {
      throw ApiError.forbidden();
    }
    // Impersonating connectors (Google domain-wide delegation) mint the
    // token subject from the acting identity — no resolved identity would
    // fall back to the admin subject, i.e. a non-admin reading the admin's
    // mailbox. The call is refused instead of defaulted.
    if (actingAs === null && !isAdmin && turn.slug === "google_workspace") {
      throw ApiError.forbidden();
    }
    // The body is the JSON arguments object (empty body = {}); any JSON
    // value that is not an object is refused, as in Rust. The route's scope
    // parses every content type as raw bytes (axum Bytes semantics).
    const rawBody = req.body as Buffer | undefined;
    let args: unknown = {};
    if (rawBody !== undefined && rawBody.length > 0) {
      try {
        args = JSON.parse(rawBody.toString("utf8"));
      } catch {
        throw ApiError.badRequest("body must be a JSON object");
      }
    }
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      throw ApiError.badRequest("body must be a JSON object");
    }
    // Runtime boundary (spec decision 8): the connector runtime is not
    // ported. Every validated call fails exactly the way the Rust server
    // fails with the connector's backend unreachable — HTTP 200 with
    // `{"ok": false, "error": "…"}` — journaled as a failed script call.
    const errorText = turn.executor === "mcp"
      ? `integration ${turn.slug} unreachable: mcp handshake failed`
      : `${turn.slug} unreachable: connector runtime is not available in this deployment`;    // Journaled audit (spec §8): the identity record for the script call.
    try {
      await auth.events.emit(caller.org, "integration.tool_called", {
        slug: turn.slug,
        call_id: crypto.randomUUID(),
        tool: raw,
        caller: caller.userId,
        acting_as: actingAs,
        ok: false,
        via: "script",
      });
    } catch {
      // Best-effort, as in Rust.
    }
    sendJson(reply, { ok: false, error: errorText });
    return reply;
  });
}
