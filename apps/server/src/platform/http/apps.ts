// Apps (docs/domain/004-capabilities.md, "Apps"): the list, one App with its
// data functions as the viewer may call them, the signed page link, the page
// itself, and the data-function call.
//
// The page runs in a frame with an opaque origin and no network: its policy
// allows no fetch, no remote image, no popup and no form target. The only
// way out is `postMessage` to the Guild client that frames it, which calls
// the function route below with the viewer's own session. Every call acts
// for the viewer: their Integration reach, the Org's curation, and the
// `integration.tool_called` audit, exactly as a script call.

import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { GatewayCtx, IdentityCtx } from "../route-contexts.js";
import { ApiError } from "../errors.js";
import { parseUuidParam, queryParam, requireUser, sendJson } from "./error.js";
import { isWorkRequest } from "./client-contract.js";
import type { AppRow, AppStore } from "../store/apps.js";
import { AppFunctionError, appFunctionClass, bindAppFunction, type AppFunction } from "../domain/app-functions.js";
import { IntegrationAccessStore } from "../store/integration-access.js";
import { memberTool, runMemberTool, type IntegrationCaller } from "../../integrations/member-tools.js";
import type { UserRow } from "../store/identity.js";

/** How long a page link stays valid: long enough to open and reload. */
export const APP_LINK_TTL_SECONDS = 600;

/** The largest tool result a page receives. */
export const MAX_APP_RESULT_BYTES = 4 * 1024 * 1024;

/** Calls one member may make to one App per minute. */
export const APP_CALLS_PER_MINUTE = 120;

/** The CDNs a page may load scripts, styles and fonts from. A request to
 *  them carries no data the page chose beyond the URL of a public file. */
const CDNS = "https://cdn.jsdelivr.net https://cdnjs.cloudflare.com https://unpkg.com";

/** The policy an App page is served under. `sandbox` forces an opaque
 *  origin; `connect-src 'none'`, local-only images and no popups or form
 *  targets leave `postMessage` to the framing client as the page's only
 *  channel. The desktop shell's origins may frame it as well as this one. */
export const APP_CSP = [
  "sandbox allow-scripts allow-forms allow-modals",
  "default-src 'none'",
  `script-src 'unsafe-inline' 'unsafe-eval' ${CDNS}`,
  `style-src 'unsafe-inline' https://fonts.googleapis.com ${CDNS}`,
  `font-src data: https://fonts.gstatic.com ${CDNS}`,
  "img-src data: blob:",
  "media-src data: blob:",
  "worker-src blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self' tauri://localhost http://tauri.localhost https://tauri.localhost",
].join("; ");

/** The page's side of the bridge, injected before any of the App's own
 *  scripts. `guild.call(name, params)` resolves with the function's result
 *  (parsed JSON when the tool answered JSON, else the text); `guild.ready`
 *  resolves once the client has sent the App's facts. */
export const APP_BRIDGE = `<script>
(function () {
  var pending = {};
  var seq = 0;
  var resolveReady;
  var guild = {
    app: null,
    functions: [],
    theme: "light",
    ready: new Promise(function (resolve) { resolveReady = resolve; }),
    call: function (name, params) {
      return guild.callRaw(name, params).then(function (result) { return result.data; });
    },
    callRaw: function (name, params) {
      return send("call", { name: String(name), params: params || {} });
    },
  };
  function send(op, body) {
    var id = ++seq;
    return new Promise(function (resolve, reject) {
      pending[id] = { resolve: resolve, reject: reject };
      var message = { guild: 1, id: id, op: op };
      for (var key in body) message[key] = body[key];
      window.parent.postMessage(message, "*");
    });
  }
  function applyTheme(theme) {
    guild.theme = theme === "dark" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", guild.theme);
    document.documentElement.style.colorScheme = guild.theme;
  }
  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var message = event.data;
    if (!message || message.guild !== 1) return;
    if (message.op === "init") {
      guild.app = message.app;
      guild.functions = message.functions || [];
      applyTheme(message.theme);
      resolveReady(guild);
      return;
    }
    if (message.op === "theme") {
      applyTheme(message.theme);
      window.dispatchEvent(new CustomEvent("guild:theme", { detail: guild.theme }));
      return;
    }
    var entry = pending[message.id];
    if (!entry) return;
    delete pending[message.id];
    if (message.ok) entry.resolve(message.result);
    else entry.reject(new Error(message.error || "call failed"));
  });
  window.guild = guild;
  window.parent.postMessage({ guild: 1, op: "hello" }, "*");
})();
</script>`;

/** The page with the bridge placed first: after `<head>`, else after
 *  `<html>`, else after the doctype, else at the top. A doctype must stay
 *  first, or the page renders in quirks mode. */
export function injectBridge(html: string): string {
  for (const re of [/<head(\s[^>]*)?>/i, /<html(\s[^>]*)?>/i, /<!doctype[^>]*>/i]) {
    const match = re.exec(html);
    if (match !== null) {
      const at = match.index + match[0].length;
      return `${html.slice(0, at)}${APP_BRIDGE}${html.slice(at)}`;
    }
  }
  return `${APP_BRIDGE}${html}`;
}

const signature = (secret: string, id: string, version: number, exp: number): string =>
  createHmac("sha256", secret).update(`app:${id}:${version}:${exp}`).digest("hex");

/** The path the client frames: the page route with the version and a
 *  signed expiry. */
export function appPagePath(secret: string, id: string, version: number, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + APP_LINK_TTL_SECONDS;
  return `/api/v1/apps/${id}/page?v=${version}&sig=${exp}.${signature(secret, id, version, exp)}`;
}

function verifyPageLink(secret: string, id: string, version: number, value: string): void {
  const [rawExp, sig] = value.split(".");
  const exp = Number(rawExp);
  if (!Number.isFinite(exp) || sig === undefined) throw ApiError.unauthorized("bad app link");
  if (exp < Math.floor(Date.now() / 1000)) throw ApiError.unauthorized("app link expired");
  const a = Buffer.from(signature(secret, id, version, exp), "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw ApiError.unauthorized("bad app link");
}

/** One data function as a viewer sees it: whether they may call it, and
 *  whether the client asks them before each call. */
export interface ViewerFunction {
  name: string;
  description: string;
  integration: string;
  tool: string;
  params: AppFunction["params"];
  /** The function's class; null when the viewer cannot reach the tool. */
  class: string | null;
  available: boolean;
  /** A write- or admin-class function, or one the Org curates to always
   *  ask. */
  confirm: boolean;
  /** The viewer said "always allow" to this function of this version, so
   *  its calls run without asking. */
  granted: boolean;
  /** The function's fixed arguments, with `{"$param"}` holes: what the
   *  confirmation shows the viewer. */
  args: AppFunction["args"];
  /** Why the viewer cannot call it. */
  reason: string | null;
}

/** A per-member, per-App call budget over a sliding minute. */
class CallBudget {
  private readonly calls = new Map<string, number[]>();

  take(key: string, now = Date.now()): boolean {
    const recent = (this.calls.get(key) ?? []).filter((at) => now - at < 60_000);
    if (recent.length >= APP_CALLS_PER_MINUTE) {
      this.calls.set(key, recent);
      return false;
    }
    recent.push(now);
    this.calls.set(key, recent);
    if (this.calls.size > 10_000) this.calls.clear();
    return true;
  }
}

function callerOf(user: UserRow): IntegrationCaller {
  return {
    org: user.org_id,
    userId: user.id,
    email: user.email,
    role: user.role,
  };
}

export function registerAppRoutes(app: FastifyInstance, auth: IdentityCtx, gateway: GatewayCtx, apps: AppStore): void {
  const access = new IntegrationAccessStore(gateway.integrations.pool);
  const budget = new CallBudget();

  /** The viewer's view of every function of an App. */
  const viewerFunctions = async (row: AppRow, user: UserRow): Promise<ViewerFunction[]> => {
    const caller = callerOf(user);
    const granted = await apps.grants(row.id, user.id, row.version);
    return Promise.all(
      row.functions.map(async (fn): Promise<ViewerFunction> => {
        const base = {
          name: fn.name,
          description: fn.description,
          integration: fn.integration,
          tool: fn.tool,
          params: fn.params,
          args: fn.args,
          granted: granted.has(fn.name),
        };
        try {
          const tool = await memberTool(gateway, access, caller, fn.integration, fn.tool);
          const cls = appFunctionClass(fn, tool);
          return {
            ...base,
            class: cls,
            available: true,
            confirm: cls !== "read" || tool.alwaysAsk,
            reason: null,
          };
        } catch (error) {
          const reason = error instanceof ApiError ? error.message : "unavailable";
          return {
            ...base,
            class: null,
            available: false,
            confirm: false,
            reason,
          };
        }
      }),
    );
  };

  // `GET /api/v1/apps` — the Apps the member sees (the first paint; the
  // `app_list` frame keeps it live).
  app.get("/api/v1/apps", async (req, reply) => {
    const user = await requireUser(auth, req);
    const items = (await apps.listVisible(user.org_id, [user.id])).get(user.id) ?? [];
    return sendJson(reply, { items });
  });

  // `GET /api/v1/apps/{id}` — one App with its functions as the member
  // may call them.
  app.get("/api/v1/apps/:id", async (req, reply) => {
    const user = await requireUser(auth, req);
    const row = await apps.getVisible(user.org_id, parseUuidParam(req, "id"), user);
    return sendJson(reply, {
      app: row,
      functions: await viewerFunctions(row, user),
    });
  });

  // `GET /api/v1/apps/{id}/page_link` — the signed URL the client frames.
  app.get("/api/v1/apps/:id/page_link", async (req, reply) => {
    const user = await requireUser(auth, req);
    const row = await apps.getVisible(user.org_id, parseUuidParam(req, "id"), user);
    return sendJson(reply, {
      path: appPagePath(auth.config.jwtSecret, row.id, row.version),
      version: row.version,
    });
  });

  // `GET /api/v1/apps/{id}/page?v=&sig=` — the page under the App policy.
  // The frame cannot send the session, so the signature is the gate.
  app.get("/api/v1/apps/:id/page", async (req, reply) => {
    const id = parseUuidParam(req, "id");
    const version = Number(queryParam(req, "v"));
    const sig = queryParam(req, "sig");
    if (!Number.isInteger(version) || version < 1 || sig === undefined) throw ApiError.badRequest("bad app link");
    verifyPageLink(auth.config.jwtSecret, id, version, sig);
    const page = await apps.page(id, version);
    return reply
      .status(200)
      .type("text/html; charset=utf-8")
      .header("x-content-type-options", "nosniff")
      .header("referrer-policy", "no-referrer")
      .header("cache-control", "private, max-age=600")
      .header("content-security-policy", APP_CSP)
      .send(injectBridge(page.html));
  });

  // `POST /api/v1/apps/{id}/functions/{name}` — one data-function call for
  // the member. Body: `{"params": {...}, "confirmed": bool, "remember":
  // bool}`. A function whose tool is write- or admin-class, or curated to
  // always ask, needs `confirmed: true` (sent only after the member said
  // yes) or a grant for this version; `remember: true` with the yes records
  // that grant. A connector failure is a 200 `ok: false` result.
  app.post("/api/v1/apps/:id/functions/:name", async (req, reply) => {
    const user = await requireUser(auth, req);
    const row = await apps.getVisible(user.org_id, parseUuidParam(req, "id"), user);
    const name = (req.params as Record<string, string>)["name"] ?? "";
    const fn = row.functions.find((item) => item.name === name);
    if (fn === undefined) throw ApiError.notFound("no such function");
    const body = (req.body ?? {}) as Record<string, unknown>;
    let args;
    try {
      args = bindAppFunction(fn, body["params"]);
    } catch (error) {
      if (error instanceof AppFunctionError) throw ApiError.badRequest(error.message);
      throw error;
    }
    const caller = callerOf(user);
    const tool = await memberTool(gateway, access, caller, fn.integration, fn.tool);
    if (appFunctionClass(fn, tool) !== "read" || tool.alwaysAsk) {
      const confirmed = body["confirmed"] === true;
      if (confirmed && body["remember"] === true) {
        await apps.grant(row.id, user.id, row.version, fn.name);
      } else if (!confirmed && !(await apps.grants(row.id, user.id, row.version)).has(fn.name)) {
        throw ApiError.conflict(
          "confirmation_required",
          `${fn.name} uses a tool that can change data and needs your confirmation`,
        );
      }
    }
    if (!budget.take(`${user.id}:${row.id}`)) {
      throw new ApiError(429, "rate_limited", "this app is calling too often; wait a minute");
    }
    const result = await runMemberTool(gateway, auth.events, caller, tool.turn, tool.raw, args, user.email, {
      via: "app",
      app_id: row.id,
      function: fn.name,
    });
    if (result.ok && Buffer.byteLength(result.content) > MAX_APP_RESULT_BYTES) {
      return sendJson(reply, {
        ok: false,
        error: "the result is larger than 4 MiB; narrow the function's query",
      });
    }
    return sendJson(reply, result);
  });

  // `DELETE /api/v1/apps/{id}/grants` — the member takes back every
  // "always allow" they gave this App.
  app.delete("/api/v1/apps/:id/grants", async (req, reply) => {
    const user = await requireUser(auth, req);
    const row = await apps.getVisible(user.org_id, parseUuidParam(req, "id"), user);
    await apps.clearGrants(row.id, user.id);
    return sendJson(reply, { cleared: true });
  });

  // `DELETE /api/v1/apps/{id}` — the owner, or an admin for a shared App.
  app.delete("/api/v1/apps/:id", async (req, reply) => {
    const user = await requireUser(auth, req);
    const id = parseUuidParam(req, "id");
    if (isWorkRequest(req) && user.role === "admin") {
      const row = await apps.getVisible(user.org_id, id, user);
      if (row.owner_user_id !== user.id) throw ApiError.forbidden("manage shared apps in the Control Center");
    }
    await apps.delete(user.org_id, id, user);
    return sendJson(reply, { deleted: true });
  });
}
