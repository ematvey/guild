// Embedded web UI serving: the SPA bundle
// is read from disk (baked into the image at build time, apps/desktop/
// dist); non-API GETs fall back to index.html (SPA routing). When the
// frontend hasn't been built, API routes still work and pages answer with
// a 503 hint.
//
// The fallback runs as an onRequest hook (not a route) so it short-circuits
// before routing without conflicting with the native API routes; every path
// it skips falls through to routing — the API routes, then the not-found
// envelope.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../../config.js";
import { ChatDist } from "../web-bundle.js";

/** Content types for the extensions the frontend bundle carries;
 *  anything else is application/octet-stream. */
const MIME: Record<string, string> = {
  html: "text/html",
  js: "text/javascript",
  mjs: "text/javascript",
  css: "text/css",
  json: "application/json",
  map: "application/json",
  webmanifest: "application/manifest+json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  txt: "text/plain",
  wasm: "application/wasm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  xml: "text/xml",
};

function mimeGuess(path: string): string {
  const dot = path.lastIndexOf(".");
  const ext = dot === -1 ? "" : path.slice(dot + 1).toLowerCase();
  return MIME[ext] ?? "application/octet-stream";
}

const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: http: https:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    // The preview pane frames a file: its signed URL is same-origin, and a
    // blob is what the pane mints when it already holds the bytes.
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

function applySecurityHeaders(reply: FastifyReply): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
}

function serveFile(dist: ChatDist, path: string, reply: FastifyReply): FastifyReply | null {
  const content = dist.file(path);
  if (content === null) return null;
  applySecurityHeaders(reply);
  // Hashed bundle assets are immutable; everything else (index.html, sw.js)
  // must revalidate on every load or deploys leave stale shells behind.
  const slashPath = path.startsWith("/") ? path : `/${path}`;
  const cache =
    slashPath.includes("/assets/") && path.includes(".") && !path.endsWith(".html")
      ? "public, max-age=31536000, immutable"
      : "no-cache";
  return reply.status(200).type(mimeGuess(path)).header("cache-control", cache).send(content);
}

export function registerWebRoutes(app: FastifyInstance, cfg: Pick<Config, "webDistDir">): void {
  const dist = new ChatDist(cfg);
  const hint = "chat app not built — run `npm --prefix apps/desktop run build`";
  const fallback = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    // Only GET/HEAD serve pages; other methods answer the not-found handler.
    if (req.method !== "GET" && req.method !== "HEAD") return;
    const path = (req.url.split("?")[0] ?? "/").replace(/^\/+$/, "/");
    // Unmatched /api routes answer the not-found envelope.
    if (path === "/api" || path.startsWith("/api/")) return;
    // Unmatched paths under the LLM gateway surfaces fall through the same
    // way.
    if (path.startsWith("/openai/v1") || path.startsWith("/anthropic/v1")) return;
    // A real bundled file wins; every other non-API path is an SPA route
    // and serves index.html — including paths with dots (model ids,
    // provider slugs).
    if (path !== "/") {
      const served = serveFile(dist, path.replace(/^\//, ""), reply);
      if (served !== null) {
        return;
      }
    }
    const index = serveFile(dist, "index.html", reply);
    if (index !== null) {
      return;
    }
    applySecurityHeaders(reply);
    await reply.status(503).type("text/plain; charset=utf-8").send(hint);
  };
  app.addHook("onRequest", fallback);
}
