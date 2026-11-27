import type { FastifyInstance, FastifyRequest, RouteOptions } from "fastify";

export const WORK_API = "/api/v1/work";
export const CONTROL_API = "/api/v1/control";

const identity = /^\/(?:auth\/(?:login|logout|refresh|me|oidc\/(?:status|login))|ws\/ticket)$/;
const common = /^\/(?:models$|orgs\/[^/]+\/logo$|access(?:\/|$)|apps(?:\/|$))/;
const work =
  /^\/(?:chats|threads|attachments|tool_artifacts|api-keys|projects|machines|sidebar|assistant|inbox|releases|push|me|preview_link)(?:\/|$)/;
const control = /^\/(?:admin|activity|usage|api-keys|mcp|registry|events|org|runs)(?:\/|$)/;
const workAgents = /^\/agents(?:$|\/[^/]+\/(?:routines|threads|turns)(?:\/|$))/;

export function isWorkRequest(req: FastifyRequest): boolean {
  const url = req.routeOptions.url;
  return url?.startsWith(WORK_API + "/") === true || (
    url?.startsWith("/api/v1/") === true && !url.startsWith(CONTROL_API + "/") &&
    req.headers["x-guild-client-surface"] === "guild"
  );
}

export function registerClientContracts(scope: FastifyInstance): void {
  const routes: RouteOptions[] = [];
  const guildRoutes = new Set<string>();
  scope.addHook("onRequest", async (req, reply) => {
    const url = req.routeOptions.url;
    if (isWorkRequest(req) && !url?.startsWith(WORK_API + "/") && !guildRoutes.has(`${req.method} ${url}`)) {
      return reply.callNotFound();
    }
  });
  scope.addHook("onRoute", (route) => {
    if (!route.url.startsWith("/api/v1/") || /^\/api\/v1\/(?:work|control)\//.test(route.url)) return;
    const suffix = route.url.slice("/api/v1".length);
    const read = route.method === "GET" || route.method === "HEAD";
    const shared = identity.test(suffix) || common.test(suffix) || suffix === "/assistant";
    const skill = suffix === "/skills" || suffix.startsWith("/skills/");
    const workSkill =
      skill && ((read && !/^\/skills\/(?:activity|teams)$/.test(suffix)) || /\/(?:install|pin)$/.test(suffix));
    const workAgent = workAgents.test(suffix) && (read || suffix !== "/agents");
    const workAuth = /^\/auth\/(?:pair|pairing-tokens)(?:\/|$)/.test(suffix);
    const controlAgent = /^\/agents(?:\/|$)/.test(suffix);
    const controlChatRead = read && /^\/(?:chats|threads|attachments|tool_artifacts)(?:\/|$)/.test(suffix);
    const prefixes = [
      ...(shared || work.test(suffix) || workSkill || workAgent || workAuth ? [WORK_API] : []),
      ...(shared || control.test(suffix) || controlAgent || skill || controlChatRead ? [CONTROL_API] : []),
    ];
    if (prefixes.includes(WORK_API)) {
      for (const method of Array.isArray(route.method) ? route.method : [route.method]) {
        guildRoutes.add(`${method} ${route.url}`);
      }
    }
    for (const prefix of prefixes) {
      const url = prefix + suffix;
      routes.push({ ...route, url, exposeHeadRoute: false });
    }
  });
  scope.after(() => {
    for (const route of routes) scope.route(route);
  });
}
