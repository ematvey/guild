// Fastify app shell: health, the platform routes (auth, chats/turns,
// gateway, hub, registry, releases, projects, integrations), the member
// socket upgrade, Faro ingest and the web UI. Unmatched paths answer the
// /api/v1 not-found envelope.

import { createRequire } from "node:module";
import Fastify, { type FastifyBaseLogger } from "fastify";
import pino from "pino";
import type { Config } from "./config.js";
import { PlatformContext } from "./composition.js";
import { registerPlatformRoutes } from "./platform/http/register.js";
import { attachWsUpgrade } from "./platform/http/ws.js";
import { registerWebRoutes } from "./platform/http/web.js";
import { registerFaroRoute } from "./platform/http/faro.js";
import { registerCors } from "./platform/http/cors.js";
import { ApiError } from "./platform/errors.js";

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

// Default body limit for ordinary JSON routes. The few upload surfaces set
// their own larger limit on the route (releases 512 MiB, attachments 64 MiB,
// registry bundles 50 MiB, org logo 2 MiB).
const BODY_LIMIT_BYTES = 1024 * 1024;

export async function buildApp(config: Config) {
  const logger = pino({
    level: config.logLevel,
    base: { version: GUILD_TS_SERVER_VERSION },
  });

  // The app is typed with Fastify's base logger, the type every route
  // module takes; the pino instance satisfies it.
  const appLogger: FastifyBaseLogger = logger;
  const app = Fastify({
    loggerInstance: appLogger,
    bodyLimit: BODY_LIMIT_BYTES,
  });

  const platform = new PlatformContext(config, logger);
  // Test/diagnostic surface (buildApp's consumers read the wiring).
  app.decorate("platform", platform);

  // Bootstrap: every migration (platform, durable, chat mapping), then the
  // agent runtime opens its harness. A failed start closes what the
  // composition root opened (pool, LISTEN hub, feed, workers).
  try {
    await platform.start();
  } catch (error) {
    await platform.close().catch((closeError: unknown) => {
      logger.warn({ err: closeError }, "close after failed start failed");
    });
    throw error;
  }

  // CORS: preflights answered before routing, ACAO rides for the
  // allow-listed webview origins.
  registerCors(app);

  // Health: {"status":"ok","version":...}.
  app.get("/api/v1/health", async () => ({
    status: "ok",
    version: GUILD_TS_SERVER_VERSION,
  }));

  // Platform routes (auth, org, events, attachments, OIDC, gateway, chats,
  // hub, registry, integrations, …), registered in encapsulated plugins so
  // the error envelope and content parsers stay scoped.
  await registerPlatformRoutes(app, platform);

  // The /api/v1/ws upgrade listener (the ws-ticket and machine-registry HTTP
  // routes are registered inside the platform plugin, see register.ts). It
  // is the server's ONLY 'upgrade' handler.
  attachWsUpgrade(app.server, platform, platform);

  // The web UI (SPA fallback from the dist on disk) as an onRequest hook —
  // it short-circuits for non-API GET/HEAD paths; everything it skips flows
  // to the native routes or the not-found handler. And the Faro telemetry
  // ingest (unauthenticated, fire-and-forget).
  registerWebRoutes(app, config);
  registerFaroRoute(app, platform.config);

  // Unmatched routes answer the not-found envelope.
  app.setNotFoundHandler(async (_req, reply) => {
    void reply
      .status(404)
      .type("application/json")
      .send(JSON.stringify(ApiError.notFound("no such route").envelope()));
    return reply;
  });

  app.addHook("onClose", async () => {
    await platform.close();
  });

  return app;
}
