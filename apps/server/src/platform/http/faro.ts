// Faro telemetry forwarding: the web UI (same origin) and the desktop webview (paired server URL) POST Faro
// Web SDK payloads to /faro/collect; the server forwards them to the org's
// Faro receiver (GUILD_FARO_URL). Intentionally unauthenticated — telemetry
// must work pre-login and pre-pairing — and fire-and-forget: an
// unreachable collector answers 202 so clients never surface telemetry
// errors.

import type { FastifyInstance, FastifyReply } from "fastify";
import type { Config } from "../../config.js";
import { bodyBytes } from "./error.js";

/** Upstream timeout: telemetry is best-effort; never hold a browser long. */
const UPSTREAM_TIMEOUT_MS = 5_000;
/** Faro payloads are small (batched browser events); hard cap anyway. */
const MAX_BODY = 1024 * 1024;

export function registerFaroRoute(app: FastifyInstance, config: Config): void {
  void app.register(async (scope) => {
    // Encapsulated raw-body parsers: the route forwards the exact request
    // bytes. Both parsers are needed — an inherited
    // exact-match application/json parser would outrank the wildcard.
    scope.addContentTypeParser("application/json", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
    scope.post("/faro/collect", { bodyLimit: MAX_BODY }, async (req, reply: FastifyReply) => {
      const url = config.faroUrl.trim();
      if (url === "") {
        // Telemetry disabled at the server: accept and drop quietly.
        return reply.status(202).send();
      }
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: bodyBytes(req),
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        // The upstream status passes through; anything unparsable is 202.
        const status = res.status >= 200 && res.status <= 599 ? res.status : 202;
        return reply.status(status).send();
      } catch {
        // Collector down is a server ops problem, not an app problem.
        return reply.status(202).send();
      }
    });
  });
}
