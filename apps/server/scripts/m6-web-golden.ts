// Web-serving golden check: fetch the SPA surface from the live Rust stack
// (:18080), replay the same files through the TS server's ChatDist from a
// temp dist, and compare status + bytes + content-type + cache-control per
// path. Requires the live stack (read-only) — run with:
//   npx tsx scripts/m6-web-golden.ts [baseUrl]

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { registerWebRoutes } from "../src/http/web.js";

const BASE = process.argv[2] ?? "http://localhost:18080";

/** The golden surface: shell + hashed assets + static extras + a deep SPA
 *  route + a dotted deep route. (sw.js is intentionally absent: the vite
 *  bundle doesn't ship one — the live stack answers /sw.js with the
 *  index.html fallback, which the deep-route cases already cover.) */
const PATHS = [
  "/",
  "/assets/index-CLneK5BO.js",
  "/assets/index-mO-KyMpY.css",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/apple-touch-icon.png",
  "/settings/integrations",
  "/chat/a.b@c",
];

interface Golden {
  status: number;
  body: Buffer;
  contentType: string;
  cacheControl: string | null;
}

async function fetchGolden(path: string): Promise<Golden> {
  const res = await fetch(`${BASE}${path}`);
  const body = Buffer.from(await res.arrayBuffer());
  return {
    status: res.status,
    body,
    contentType: res.headers.get("content-type") ?? "",
    cacheControl: res.headers.get("cache-control"),
  };
}

async function main(): Promise<void> {
  const goldens = new Map<string, Golden>();
  for (const p of PATHS) goldens.set(p, await fetchGolden(p));

  // Replay the static golden bytes into a temp dist (deep SPA routes are
  // fallback cases — they must NOT be written as files).
  const dist = mkdtempSync(path.join(tmpdir(), "m6-web-golden-"));
  try {
    for (const [p, g] of goldens) {
      if (g.status !== 200) continue;
      if (p !== "/" && !p.startsWith("/assets/") && !/\.[a-z0-9]+$/i.test(p)) continue;
      const rel = p === "/" ? "index.html" : p.replace(/^\//, "");
      const file = path.join(dist, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, g.body);
    }
    const app = Fastify({ logger: false });
    registerWebRoutes(app, { webDistDir: dist });
    await app.ready();

    let failures = 0;
    for (const [p, g] of goldens) {
      const res = await app.inject({ method: "GET", url: p });
      const issues: string[] = [];
      if (res.statusCode !== g.status) issues.push(`status ${res.statusCode} != ${g.status}`);
      if (g.status === 200) {
        // rawPayload keeps the exact response bytes; payload/body are
        // lossy UTF-8 decodes for binary assets.
        const served =
          (res as unknown as { rawPayload?: Buffer }).rawPayload ?? Buffer.from(res.body);
        if (served.length !== g.body.length || Buffer.compare(served, g.body) !== 0) {
          issues.push(`bytes differ (mine ${served.length}B vs golden ${g.body.length}B)`);
        }
      }
      const ct = String(res.headers["content-type"] ?? "");
      if (g.status === 200 && !ct.startsWith(g.contentType.split(";")[0]!)) {
        issues.push(`content-type ${ct} != ${g.contentType}`);
      }
      const cc = (res.headers["cache-control"] as string | undefined) ?? null;
      if (cc !== g.cacheControl) issues.push(`cache-control ${cc} != ${g.cacheControl}`);
      if (issues.length === 0) {
        console.log(`PASS ${p} (${g.status}, ${g.body.length}B, ct=${g.contentType}, cc=${cc})`);
      } else {
        failures += 1;
        console.log(`FAIL ${p}: ${issues.join("; ")}`);
      }
    }
    await app.close();
    if (failures > 0) {
      console.log(`GOLDEN: FAIL — ${failures} path(s) differ`);
      process.exitCode = 1;
    } else {
      console.log(`GOLDEN: PASS — ${goldens.size} path(s) byte- and header-identical against ${BASE}`);
    }
  } finally {
    rmSync(dist, { recursive: true, force: true });
  }
}

void main();
