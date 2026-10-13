// Fastify app shell: the native platform routes (health, auth, chats/turns,
// gateway, hub, registry, releases, projects, integrations, faro, web UI).
// The Rust upstream and the M0 proxy-everything are retired: this process
// serves the whole public surface; un-ported routes (routines, hooks,
// internal — spec decision 8) answer the Rust not-found envelope.

import { createRequire } from "node:module";
import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import type { Config } from "./config.js";
import { PlatformContext } from "./platform/context.js";
import { NATIVE_ROUTE_GROUPS, registerPlatformRoutes } from "./platform/http/register.js";
import { attachWsUpgrade } from "./http/ws.js";
import { wireWsSync } from "./chats/ws-sync.js";
import { registerWebRoutes } from "./http/web.js";
import { registerFaroRoute } from "./platform/http/faro.js";
import { registerCors } from "./http/cors.js";

const require = createRequire(import.meta.url);

export const GUILD_TS_SERVER_VERSION: string = (() => {
  try {
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** The composition root rides the app instance: tests and diagnostics read
 *  the wiring through `app.platform`. */
declare module "fastify" {
  interface FastifyInstance {
    platform: PlatformContext;
  }
}

// Native route groups. Anything listed here is served by this process;
// everything else answers the not-found handler below (deferred routes are
// unreachable by design — spec decision 8).
export const NATIVE_ROUTES = [
  "/api/v1/health",
  ...NATIVE_ROUTE_GROUPS.flatMap((g) => g.paths),
];

// Body limit mirrors the largest upload surface (releases: 512 MiB,
// attachments: 64 MiB).
const BODY_LIMIT_BYTES = 512 * 1024 * 1024;

export async function buildApp(config: Config) {
  const logger = pino({
    level: config.logLevel,
    base: { version: GUILD_TS_SERVER_VERSION },
  });

  const app = Fastify({
    loggerInstance: logger,
    bodyLimit: BODY_LIMIT_BYTES,
  });

  const platform = new PlatformContext(config, logger);
  // Test/diagnostic surface (buildApp's consumers read the wiring).
  app.decorate("platform", platform);

  // Bootstrap the agent runtime (decision 9: one owning process): applies
  // the durable_* migrations + the chat-conversation mapping idempotently
  // and opens the harness. Turn submission paths reuse it (lazy no-op).
  await platform.runtime.start();

  // CORS: the tower-http layer's port — preflights answered before routing,
  // ACAO rides for the allow-listed webview origins.
  registerCors(app as unknown as Parameters<typeof registerCors>[0]);

  // Native health route — same shape as the Rust one
  //: {"status":"ok","version":...}.
  app.get("/api/v1/health", async () => ({
    status: "ok",
    version: GUILD_TS_SERVER_VERSION,
  }));

  // Native platform routes (auth, org, events, attachments, OIDC, gateway,
  // chats, hub, registry, integrations, …), registered in one encapsulated
  // plugin so the error envelope and content parsers stay scoped.
  await registerPlatformRoutes(app as unknown as FastifyInstance, platform);

  // Hub core: the /api/v1/ws upgrade listener + the ws-ticket and
  // machine-registry HTTP routes (the latter registered inside the platform
  // plugin, see register.ts, so the M1 error envelope and content parsers
  // apply). The upgrade listener is the server's ONLY 'upgrade' handler.
  platform.wsLog = (message) => logger.info({ ws: message }, "ws");
  attachWsUpgrade(app.server, platform, platform, platform.pool);

  // The chats lane's sync capture (SyncBegin … ThreadState … SyncDone).
  wireWsSync(platform);

  // The web UI (SPA fallback from the dist on disk) as an onRequest hook —
  // it short-circuits for non-API GET/HEAD paths; everything it skips flows
  // to the native routes or the not-found handler. And the Faro telemetry
  // ingest (unauthenticated, fire-and-forget).
  registerWebRoutes(app as unknown as FastifyInstance, config);
  registerFaroRoute(app as unknown as FastifyInstance, platform.config);

  // Unmatched routes answer the not-found envelope; deferred surfaces
  // (routines, hooks, internal — spec decision 8) are unreachable, cleanly.
  app.setNotFoundHandler(async (_req, reply) => {
    void reply.status(404).type("application/json").send(
      JSON.stringify({ error: { code: "not_found", message: "no such route" } }),
    );
    return reply;
  });

  app.addHook("onClose", async () => {
    await platform.close();
  });

  return app;
}
