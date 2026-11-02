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

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Config } from "../config.js";

/** The web app (tauri frontend) at `/`. */
export class ChatDist {
  /** Resolved directory, or null when not configured / not a directory. */
  readonly dir: string | null;

  constructor(cfg: Pick<Config, "webDistDir">) {
    this.dir =
      cfg.webDistDir !== null &&
      cfg.webDistDir !== "" &&
      existsSync(cfg.webDistDir) &&
      statSync(cfg.webDistDir).isDirectory()
        ? resolve(cfg.webDistDir)
        : null;
  }

  file(path: string): Buffer | null {
    if (this.dir === null) return null;
    const full = join(this.dir, path);
    // The dist directory is a fixed build artifact; anything escaping it is
    // not a bundled file.
    if (!full.startsWith(this.dir + "/")) return null;
    try {
      const st = statSync(full);
      if (!st.isFile()) return null;
      return readFileSync(full);
    } catch {
      return null;
    }
  }
}

/** The identity of the served web bundle: the content hash in the entry
 *  script's name (`assets/index-<hash>.js`) that index.html loads. null
 *  when no bundle is served. A browser client compares it with the bundle
 *  it runs. */
export function webBundleId(dist: Pick<ChatDist, "file">): string | null {
  const index = dist.file("index.html");
  if (index === null) return null;
  return /\/assets\/index-([^"'/]+)\.js/.exec(index.toString("utf8"))?.[1] ?? null;
}

const bundleIds = new Map<string, string | null>();

/** The served bundle's identity for a config, read once per dist directory:
 *  the bundle is baked into the image and does not change while the
 *  process runs. */
export function servedWebBundle(cfg: Pick<Config, "webDistDir">): string | null {
  const key = cfg.webDistDir ?? "";
  if (!bundleIds.has(key)) bundleIds.set(key, webBundleId(new ChatDist(cfg)));
  return bundleIds.get(key) ?? null;
}

/** mime_guess::from_path().first_or_octet_stream() for the extensions the
 *  frontend bundle carries. */
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
