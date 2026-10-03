// Fastify app shell: native health route + proxy-everything to the Rust
// server (HTTP + WebSocket upgrade), per the M0 design (decision 3: TS in
// front, un-ported routes reverse-proxied; each ported route flips to
// native TS, rollback = delete the TS route).

import { createRequire } from "node:module";
import Fastify from "fastify";
import pino from "pino";
import proxy from "@fastify/http-proxy";
import type { Config } from "./config.js";

const require = createRequire(import.meta.url);

export const GUILD_TS_SERVER_VERSION: string = (() => {
  try {
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// Native (non-proxied) routes. Anything listed here is served by this
// process; every other path is forwarded to the Rust upstream. To flip a
// route group to native TS, register it here; to roll back, delete the
// route and the proxy resumes.
export const NATIVE_ROUTES = ["/api/v1/health"];

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

  // Native health route — same shape as the Rust one
  // (crates/server/src/http/mod.rs): {"status":"ok","version":...}.
  app.get("/api/v1/health", async () => ({
    status: "ok",
    version: GUILD_TS_SERVER_VERSION,
  }));

  // Proxy everything else — HTTP bodies (streamed through), status codes,
  // response headers, and WS upgrades (the hub route is /api/v1/ws,
  // crates/server/src/http/ws.rs; daemons use no subprotocols, so the
  // proxy's first-subprotocol-only limitation does not bite).
  //
  // @fastify/websocket is deliberately NOT registered: the proxy's
  // `websocket: true` mode installs the server's sole 'upgrade' listener
  // (it routes upgrades through the wildcard route itself); a second
  // listener from @fastify/websocket would double-assign the socket and
  // crash the upgrade (ERR_HTTP_SOCKET_ASSIGNED).
  await app.register(proxy, {
    upstream: config.upstreamUrl,
    websocket: true,
  });

  return app;
}
