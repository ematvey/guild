// Fastify app shell: native platform routes (health, M1 platform core) +
// proxy-everything to the Rust server (HTTP + WebSocket upgrade), per the
// M0 design (decision 3: TS in front, un-ported routes reverse-proxied;
// each ported route flips to native TS, rollback = delete the TS route).

import { createRequire } from "node:module";
import Fastify, { type FastifyInstance } from "fastify";
import pino from "pino";
import proxy from "@fastify/http-proxy";
import type { Config } from "./config.js";
import { PlatformContext } from "./platform/context.js";
import { NATIVE_ROUTE_GROUPS, registerPlatformRoutes } from "./platform/http/register.js";
import { attachWsUpgrade } from "./http/ws.js";

const require = createRequire(import.meta.url);

export const GUILD_TS_SERVER_VERSION: string = (() => {
  try {
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// Native (non-proxied) route groups. Anything listed here is served by this
// process; every other path is forwarded to the Rust upstream. To roll a
// group back, delete its registration in registerPlatformRoutes and the
// proxy resumes.
export const NATIVE_ROUTES = [
  "/api/v1/health",
  ...NATIVE_ROUTE_GROUPS.flatMap((g) => g.paths),
];

// Body limit mirrors the largest Rust limit (releases: 512 MiB,
// attachments: 64 MiB — crates/server/src/http/releases.rs / attachments.rs).
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
  (app as unknown as { platform: PlatformContext }).platform = platform;

  // Bootstrap the agent runtime (decision 9: one owning process): applies
  // the durable_* migrations + the chat-conversation mapping idempotently
  // and opens the harness. Turn submission paths reuse it (lazy no-op).
  await platform.runtime.start();

  // Native health route — same shape as the Rust one
  // (crates/server/src/http/mod.rs): {"status":"ok","version":...}.
  app.get("/api/v1/health", async () => ({
    status: "ok",
    version: GUILD_TS_SERVER_VERSION,
  }));

  // Native M1 platform routes (auth, org, events, attachments, OIDC),
  // registered before the proxy so they win route matching; the proxy
  // catch-all underneath keeps every un-ported path working.
  await registerPlatformRoutes(app as unknown as FastifyInstance, platform);

  // Native M5 hub core: the /api/v1/ws upgrade listener + the ws-ticket and
  // machine-registry HTTP routes (the latter registered inside the platform
  // plugin, see register.ts, so the M1 error envelope and content parsers
  // apply). The upgrade listener is the server's ONLY 'upgrade' handler: the
  // proxy below no longer passes `websocket: true`, because two listeners
  // double-assign the upgrade socket (ERR_HTTP_SOCKET_ASSIGNED — the M0 trap
  // note). Rust has no other WS endpoint, so no upgrade needs forwarding
  // anymore. Rollback = restore `websocket: true` and delete the
  // attachWsUpgrade call.
  platform.wsLog = (message) => logger.info({ ws: message }, "ws");
  attachWsUpgrade(app.server, platform);

  // Proxy everything else — HTTP bodies (streamed through), status codes,
  // and response headers. WS upgrades are NOT proxied anymore: the hub route
  // (/api/v1/ws) flipped native above and the Rust server has no other WS
  // endpoint.
  await app.register(proxy, {
    upstream: config.upstreamUrl,
  });

  app.addHook("onClose", async () => {
    await platform.close();
  });

  return app;
}
