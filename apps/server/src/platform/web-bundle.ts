// The web UI bundle on disk: the dist directory the server serves the SPA
// from (baked into the image at build time) and the bundle's identity, which
// the workspace identity frame carries so a browser client can tell it runs
// a stale bundle. No HTTP here: platform/http/web.ts serves the files.

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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
    if (!full.startsWith(`${this.dir}/`)) return null;
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
