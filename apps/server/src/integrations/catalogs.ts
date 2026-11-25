// Plugin catalogs: where an org discovers integrations to install. A catalog
// is a static index (format guild-plugin-catalog/1) listing plugins, their
// versions, each bundle's sha256 and where the bundle lives. The catalog
// never runs code; installing a version copies its bundle into the org's
// registry (plugin-install.ts), so the instance stops depending on the
// catalog once a version is in.
//
// Each org keeps its own catalog list (org KV). A catalog is read from:
//   url    — a public https URL of index.json (a GitHub Pages or raw file)
//   github — a file in a GitHub repository, read with the org's GitHub
//            integration token (private repositories included)
//   gitlab — a file in a GitLab project, read with the org's GitLab
//            integration token
// A relative bundle path resolves against the index's own location and is
// read through the same source (and credentials); an absolute bundle URL is
// fetched without credentials.

import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseBundle, readBundleFile } from "../platform/bundle.js";
import type { OrgKvStore } from "../platform/store/org-kv.js";
import type { IntegrationSecretStore, IntegrationStore } from "../platform/store/integrations.js";
import { fetchTimeout, githubApiUrl, gitlabBaseUrl, transportCause, type JsonObject } from "./shared.js";

export const CATALOG_FORMAT = "guild-plugin-catalog/1";
/** Org KV key of the org's catalog list. Absent = the server default. */
export const CATALOGS_KEY = "integration_catalogs";
const INDEX_MAX_BYTES = 4 * 1024 * 1024;
export const BUNDLE_MAX_BYTES = 50 * 1024 * 1024;
const FETCH_MS = 30_000;
const INDEX_TTL_MS = 5 * 60_000;
const SHA256 = /^[0-9a-f]{64}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export type CatalogSource =
  | { kind: "url"; url: string }
  | { kind: "github"; repo: string; ref: string | null; path: string }
  | { kind: "gitlab"; project: string; ref: string | null; path: string };

export interface CatalogConfig {
  id: string;
  name: string;
  source: CatalogSource;
}

export interface CatalogVersion {
  version: string;
  sha256: string;
  bundle: string;
  published_at: string | null;
}

export interface CatalogPlugin {
  slug: string;
  title: string;
  summary: string;
  publisher: string;
  categories: string[];
  traits: string[];
  docs_url: string | null;
  /** Newest first. */
  versions: CatalogVersion[];
}

export interface CatalogIndex {
  name: string;
  plugins: CatalogPlugin[];
}

export interface CatalogDeps {
  readonly orgKv: Pick<OrgKvStore, "get" | "put">;
  readonly integrations: Pick<IntegrationStore, "getByName" | "firstOfKind">;
  readonly integrationSecrets: Pick<IntegrationSecretStore, "names" | "resolve">;
  masterKey(): Buffer;
}

export class CatalogError extends Error {}

// ---------- the org's catalog list ----------

/** The catalog every org starts with, from GUILD_DEFAULT_PLUGIN_CATALOG (an
 *  index.json URL). Unset = none. */
export function defaultCatalogs(): CatalogConfig[] {
  const url = process.env["GUILD_DEFAULT_PLUGIN_CATALOG"]?.trim();
  if (url === undefined || url === "") return [];
  return [{ id: "default", name: "Guild plugins", source: { kind: "url", url } }];
}

export async function listCatalogs(kv: Pick<OrgKvStore, "get">, orgId: string): Promise<CatalogConfig[]> {
  const raw = await kv.get(orgId, CATALOGS_KEY);
  if (raw === null) return defaultCatalogs();
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const out: CatalogConfig[] = [];
    for (const item of parsed) {
      try {
        out.push(parseCatalogConfig(item, true));
      } catch {
        // a stored entry that no longer parses is dropped from the view
      }
    }
    return out;
  } catch {
    return [];
  }
}

function str(o: JsonObject, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v.trim() : "";
}

/** Validates an admin-submitted catalog (`keepId`: a stored one keeps its
 *  id; a new one gets a fresh id). */
export function parseCatalogConfig(raw: unknown, keepId = false): CatalogConfig {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    throw new CatalogError("catalog must be an object");
  const o = raw as JsonObject;
  const src = (o["source"] ?? null) as JsonObject | null;
  if (src === null || typeof src !== "object") throw new CatalogError("catalog needs a source");
  const kind = str(src, "kind");
  let source: CatalogSource;
  if (kind === "url") {
    const url = str(src, "url");
    if (!/^https?:\/\//.test(url)) throw new CatalogError("catalog url must be an absolute http(s) URL");
    source = { kind, url };
  } else if (kind === "github") {
    const repo = str(src, "repo");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new CatalogError("github catalog repo must be owner/name");
    source = { kind, repo, ref: str(src, "ref") || null, path: str(src, "path") || "index.json" };
  } else if (kind === "gitlab") {
    const project = str(src, "project");
    if (!/^[\w.-]+(\/[\w.-]+)+$/.test(project)) throw new CatalogError("gitlab catalog project must be group/name");
    source = { kind, project, ref: str(src, "ref") || null, path: str(src, "path") || "index.json" };
  } else {
    throw new CatalogError("catalog source kind must be url, github or gitlab");
  }
  if (source.kind !== "url" && (source.path.startsWith("/") || source.path.split("/").includes(".."))) {
    throw new CatalogError("catalog path must be relative to the repository root");
  }
  const name = str(o, "name") || describeSource(source);
  const id = keepId && str(o, "id") !== "" ? str(o, "id") : randomUUID();
  return { id, name, source };
}

export function describeSource(source: CatalogSource): string {
  switch (source.kind) {
    case "url":
      return source.url;
    case "github":
      return `github:${source.repo}/${source.path}${source.ref !== null ? `@${source.ref}` : ""}`;
    case "gitlab":
      return `gitlab:${source.project}/${source.path}${source.ref !== null ? `@${source.ref}` : ""}`;
  }
}

export async function saveCatalogs(kv: Pick<OrgKvStore, "put">, orgId: string, list: CatalogConfig[]): Promise<void> {
  await kv.put(orgId, CATALOGS_KEY, JSON.stringify(list));
}

// ---------- reading files from a source ----------

async function fetchCapped(url: string, init: RequestInit, max: number, what: string): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(url, fetchTimeout(FETCH_MS, init));
  } catch (error) {
    throw new CatalogError(`${what} unreachable: ${transportCause(error)}`);
  }
  if (!res.ok) throw new CatalogError(`${what}: ${res.status} ${res.statusText}`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) throw new CatalogError(`${what} exceeds ${max} bytes`);
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > max) throw new CatalogError(`${what} exceeds ${max} bytes`);
  return bytes;
}

/** The org's stored token of one first-party integration (github/gitlab)
 *  and its row config; a missing row or token says what to configure. */
async function providerCredentials(
  deps: CatalogDeps,
  orgId: string,
  provider: "github" | "gitlab",
): Promise<{ config: JsonObject; token: string }> {
  const row = await deps.integrations.firstOfKind(orgId, provider);
  const label = provider === "github" ? "GitHub" : "GitLab";
  if (row === null) throw new CatalogError(`this catalog reads through the ${label} integration; configure it first`);
  let secrets: [string, string][];
  try {
    secrets = await deps.integrationSecrets.resolve(orgId, row.name, ["token"], deps.masterKey());
  } catch {
    throw new CatalogError(`the ${label} integration has no access token stored`);
  }
  const token = secrets.find(([n]) => n === "token")?.[1];
  if (token === undefined) throw new CatalogError(`the ${label} integration has no access token stored`);
  return { config: (row.config ?? {}) as JsonObject, token };
}

function repoPath(indexPath: string, rel: string): string {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(indexPath), rel));
  if (joined.startsWith("../") || joined === ".." || joined.startsWith("/")) {
    throw new CatalogError(`bundle path ${rel} leaves the repository`);
  }
  return joined;
}

/** Reads one file of a catalog: the index itself (`rel` null) or a bundle
 *  path the index names. */
export async function readCatalogFile(
  deps: CatalogDeps,
  orgId: string,
  source: CatalogSource,
  rel: string | null,
  max: number,
): Promise<Buffer> {
  if (rel !== null && /^https?:\/\//.test(rel)) return fetchCapped(rel, {}, max, rel);
  if (source.kind === "url") {
    const url = rel === null ? source.url : new URL(rel, source.url).toString();
    return fetchCapped(url, {}, max, url);
  }
  const file = rel === null ? source.path : repoPath(source.path, rel);
  if (source.kind === "github") {
    const { config, token } = await providerCredentials(deps, orgId, "github");
    const encoded = file.split("/").map(encodeURIComponent).join("/");
    const ref = source.ref !== null ? `?ref=${encodeURIComponent(source.ref)}` : "";
    return fetchCapped(
      `${githubApiUrl(config)}/repos/${source.repo}/contents/${encoded}${ref}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github.raw",
          "x-github-api-version": "2022-11-28",
          "user-agent": "guild-plugin-catalog",
        },
      },
      max,
      `github:${source.repo}/${file}`,
    );
  }
  const { config, token } = await providerCredentials(deps, orgId, "gitlab");
  const url =
    `${gitlabBaseUrl(config)}/projects/${encodeURIComponent(source.project)}` +
    `/repository/files/${encodeURIComponent(file)}/raw?ref=${encodeURIComponent(source.ref ?? "HEAD")}`;
  return fetchCapped(url, { headers: { "private-token": token } }, max, `gitlab:${source.project}/${file}`);
}

// ---------- the index ----------

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/** Parses and validates an index. Entries that break the format are
 *  dropped; a document that is not an index at all throws. */
export function parseIndex(text: string, fallbackName: string): CatalogIndex {
  let doc: JsonObject;
  try {
    doc = JSON.parse(text) as JsonObject;
  } catch (error) {
    throw new CatalogError(`index is not JSON: ${(error as Error).message}`);
  }
  if (doc === null || typeof doc !== "object" || doc["format"] !== CATALOG_FORMAT) {
    throw new CatalogError(`index format must be ${CATALOG_FORMAT}`);
  }
  if (!Array.isArray(doc["plugins"])) throw new CatalogError("index has no plugins list");
  const plugins: CatalogPlugin[] = [];
  for (const raw of doc["plugins"] as unknown[]) {
    if (raw === null || typeof raw !== "object") continue;
    const p = raw as JsonObject;
    const slug = typeof p["slug"] === "string" ? p["slug"] : "";
    if (!SLUG.test(slug)) continue;
    const versions: CatalogVersion[] = [];
    for (const rv of Array.isArray(p["versions"]) ? (p["versions"] as unknown[]) : []) {
      if (rv === null || typeof rv !== "object") continue;
      const v = rv as JsonObject;
      if (typeof v["version"] !== "string" || v["version"] === "") continue;
      if (typeof v["sha256"] !== "string" || !SHA256.test(v["sha256"])) continue;
      if (typeof v["bundle"] !== "string" || v["bundle"] === "") continue;
      versions.push({
        version: v["version"],
        sha256: v["sha256"],
        bundle: v["bundle"],
        published_at: typeof v["published_at"] === "string" ? v["published_at"] : null,
      });
    }
    if (versions.length === 0) continue;
    plugins.push({
      slug,
      title: typeof p["title"] === "string" && p["title"] !== "" ? p["title"] : slug,
      summary: typeof p["summary"] === "string" ? p["summary"] : "",
      publisher: typeof p["publisher"] === "string" ? p["publisher"] : "",
      categories: strings(p["categories"]),
      traits: strings(p["traits"]),
      docs_url: typeof p["docs_url"] === "string" ? p["docs_url"] : null,
      versions,
    });
  }
  return { name: typeof doc["name"] === "string" && doc["name"] !== "" ? doc["name"] : fallbackName, plugins };
}

const indexCache = new Map<string, { at: number; index: CatalogIndex }>();

/** The catalog's index, cached for a few minutes per org and source;
 *  `refresh` re-reads it. */
export async function readIndex(
  deps: CatalogDeps,
  orgId: string,
  catalog: CatalogConfig,
  refresh = false,
): Promise<CatalogIndex> {
  const key = `${orgId}\u0000${JSON.stringify(catalog.source)}`;
  const hit = indexCache.get(key);
  if (!refresh && hit !== undefined && Date.now() - hit.at < INDEX_TTL_MS) return hit.index;
  const bytes = await readCatalogFile(deps, orgId, catalog.source, null, INDEX_MAX_BYTES);
  const index = parseIndex(bytes.toString("utf8"), catalog.name);
  indexCache.set(key, { at: Date.now(), index });
  return index;
}

/** Downloads one catalog version's bundle and checks it against the
 *  index's sha256. */
export async function fetchCatalogBundle(
  deps: CatalogDeps,
  orgId: string,
  catalog: CatalogConfig,
  version: CatalogVersion,
  sha256: (bytes: Buffer) => string,
): Promise<Buffer> {
  const bytes = await readCatalogFile(deps, orgId, catalog.source, version.bundle, BUNDLE_MAX_BYTES);
  if (sha256(bytes) !== version.sha256) {
    throw new CatalogError(`bundle ${version.bundle} does not match the sha256 the catalog lists`);
  }
  return bytes;
}

/** Downloads a bundle from a pasted URL (the URL install), capped. */
export function fetchBundleUrl(url: string): Promise<Buffer> {
  if (!/^https?:\/\//.test(url)) throw new CatalogError("bundle url must be an absolute http(s) URL");
  return fetchCapped(url, {}, BUNDLE_MAX_BYTES, url);
}

/** A catalog plugin's landing-page content, read from its bundle before
 *  any install: the registry manifest (fields, declared tools, traits),
 *  README.md and logo.svg. The bundle is fetched and checked against the
 *  listed sha256 like an install, then parsed; plugin.js never runs. */
export interface BundlePreview {
  sha256: string;
  manifest: Record<string, unknown>;
  readme: string;
  logo: string;
}

/** Previews by bundle hash: the hash pins the bytes, so a preview never
 *  goes stale. Bounded; the oldest entry leaves first. */
const previews = new Map<string, BundlePreview>();
const PREVIEW_CACHE = 64;

export async function previewCatalogBundle(
  deps: CatalogDeps,
  orgId: string,
  catalog: CatalogConfig,
  version: CatalogVersion,
  sha256: (bytes: Buffer) => string,
): Promise<BundlePreview> {
  const cached = previews.get(version.sha256);
  if (cached !== undefined) return cached;
  const bytes = await fetchCatalogBundle(deps, orgId, catalog, version, sha256);
  const parsed = await parseBundle(bytes);
  const manifestBytes = readBundleFile(parsed, "manifest.json");
  if (manifestBytes === null) throw new CatalogError(`bundle ${version.bundle} has no manifest.json`);
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new CatalogError(`bundle ${version.bundle} has an unreadable manifest.json`);
  }
  const preview: BundlePreview = {
    sha256: version.sha256,
    manifest,
    readme: readBundleFile(parsed, "README.md")?.toString("utf8") ?? "",
    logo: readBundleFile(parsed, "logo.svg")?.toString("utf8") ?? "",
  };
  if (previews.size >= PREVIEW_CACHE) previews.delete(previews.keys().next().value!);
  previews.set(version.sha256, preview);
  return preview;
}
