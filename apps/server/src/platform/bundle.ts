// Registry bundle reader (crates/guild-core/src/registry.rs): tar.gz with a
// `manifest.json` at the root. Publish validation and the install path read
// entries without touching the filesystem; network-delivered bundles are
// untrusted, so path traversal, duplicates, special entries and
// decompressed size are all bounded like the Rust extract/read caps.

import { gunzipSync } from "node:zlib";
import { Parser } from "tar";
import { ApiError } from "./http/error.js";

/** A decompressed bundle may not exceed this total size (bundle-bomb guard). */
const MAX_BUNDLE_TOTAL = 256 * 1024 * 1024;
/** Single-entry cap for reads out of a network-delivered bundle. */
const MAX_BUNDLE_FILE = 16 * 1024 * 1024;

export interface BundleEntry {
  path: string;
  /** true = regular file, false = directory */
  file: boolean;
  /** Regular-file contents (null for directories). */
  content: Buffer | null;
}

interface ParseOutcome {
  entries: BundleEntry[];
  manifestText: string | null;
  failure: ApiError | null;
}

export interface ParsedBundle {
  entries: BundleEntry[];
  manifest: Record<string, unknown>;
}

function bundleError(message: string): ApiError {
  return ApiError.badRequest(`invalid bundle: ${message}`);
}

function normalizeEntryPath(raw: string): string {
  // CurDir components are dropped, like the Rust reader's components filter.
  // pax/GNU long names are resolved by the tar parser itself.
  return raw
    .split("/")
    .filter((seg) => seg !== "." && seg !== "")
    .join("/");
}

/** Parses a tar.gz bundle fully in memory: validates duplicate entries,
 *  absolute/traversal paths, special files and the decompressed-size cap,
 *  and parses the root manifest.json. Throws ApiError.badRequest on any
 *  structural violation (the "invalid bundle: …" rejection class). */
export async function parseBundle(bundle: Buffer): Promise<ParsedBundle> {
  let gunzipped: Buffer;
  try {
    gunzipped = gunzipSync(bundle);
  } catch (error) {
    throw bundleError(`gzip decode failed: ${(error as Error).message}`);
  }
  if (gunzipped.length > MAX_BUNDLE_TOTAL) {
    throw bundleError(`bundle decompressed size exceeds the cap (${MAX_BUNDLE_TOTAL} bytes)`);
  }
  const outcome = await new Promise<ParseOutcome>((resolve) => {
    const parser = new Parser();
    const entries: BundleEntry[] = [];
    const seen = new Set<string>();
    let total = 0;
    let failure: ApiError | null = null;
    let pending = 0;
    let ended = false;
    const maybeFinish = (): void => {
      if (!ended || pending > 0) return;
      const manifestEntry = entries.find((e) => e.path === "manifest.json");
      resolve({ entries, manifestText: manifestEntry?.content?.toString("utf8") ?? null, failure });
    };
    parser.on("entry", (entry: { path: string; size: number; type: string } & import("node:stream").Readable) => {
      const handle = async (): Promise<void> => {
        const path = normalizeEntryPath(entry.path);
        if (path.startsWith("/")) {
          throw bundleError(`bundle entry is absolute: ${entry.path}`);
        }
        if (path === "" || path.split("/").includes("..")) {
          throw bundleError(`bundle entry escapes the destination: ${entry.path}`);
        }
        if (seen.has(path)) {
          throw bundleError(`duplicate bundle entry: ${path}`);
        }
        seen.add(path);
        total += entry.size;
        if (total > MAX_BUNDLE_TOTAL) {
          throw bundleError(`bundle decompressed size exceeds the cap (${MAX_BUNDLE_TOTAL} bytes)`);
        }
        if (entry.type === "Directory") {
          entries.push({ path, file: false, content: null });
          entry.resume();
          return;
        }
        if (entry.type !== "File") {
          throw bundleError(`bundle entry is a special file: ${entry.path}`);
        }
        if (entry.size > MAX_BUNDLE_FILE) {
          entry.resume();
          throw bundleError(`bundle entry '${path}' exceeds the ${MAX_BUNDLE_FILE}-byte read cap`);
        }
        const chunks: Buffer[] = [];
        for await (const chunk of entry) chunks.push(chunk as Buffer);
        if (Buffer.concat(chunks).length > MAX_BUNDLE_FILE) {
          throw bundleError(`bundle entry '${path}' exceeds the ${MAX_BUNDLE_FILE}-byte read cap`);
        }
        entries.push({ path, file: true, content: Buffer.concat(chunks) });
      };
      const finish = (error: unknown): void => {
        if (failure === null && error instanceof ApiError) failure = error;
        entry.resume();
        pending -= 1;
        maybeFinish();
      };
      pending += 1;
      handle().then(() => finish(undefined), finish);
    });
    parser.on("error", (error: Error) => {
      if (failure === null) failure = bundleError(`tar parse failed: ${error.message}`);
    });
    parser.on("end", () => {
      ended = true;
      maybeFinish();
    });
    parser.end(gunzipped);
  });
  if (outcome.failure !== null) throw outcome.failure;
  if (outcome.manifestText === null) throw bundleError("bundle has no manifest.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(outcome.manifestText);
  } catch (error) {
    throw bundleError(`bad manifest.json: ${(error as Error).message}`);
  }
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw bundleError("bad manifest.json: manifest.json must be a JSON object");
  }
  return { entries: outcome.entries, manifest: manifest as Record<string, unknown> };
}

/** Reads one file from a packed bundle. Returns null when the bundle has no
 *  such entry (read_bundle_file). The bundle must already be validated. */
export function readBundleFile(parsed: ParsedBundle, path: string): Buffer | null {
  const entry = parsed.entries.find((e) => e.file && e.path === path);
  return entry?.content ?? null;
}
