#!/usr/bin/env bun
// guild-plugin: builds, publishes, and catalogs Guild integration plugins.
//
//   guild-plugin pack [entry] [--out dist]
//       Bundles the plugin module (default src/integration.ts) and this SDK
//       into one plugin.js, derives manifest.json from the plugin's
//       manifest, and writes <out>/<slug>-<version>.guildplugin (a tar.gz
//       with manifest.json, plugin.js, and the nearest logo.svg between the
//       entry's folder and the working directory).
//       An entry whose default export is an `mcpIntegration(...)` packs
//       without code: manifest.json (the server, settings and header
//       templates), logo.svg and README.md. The server discovers its tools
//       live once an admin configures it.
//
//   guild-plugin publish <bundle> [--server URL] [--token TOKEN] [--approve]
//       Uploads the bundle to a Guild server's registry. --approve (admin
//       token) also approves that exact hash and installs it for the org.
//       Defaults: $GUILD_SERVER, $GUILD_TOKEN.
//
//   guild-plugin catalog add <bundle> [--index index.json] [--url URL] [--name NAME]
//       Adds the bundle's version to a catalog index. Without --url the
//       bundle is copied to bundles/ next to the index and referenced by
//       relative path (a git-hosted catalog serves it from the same repo).

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { c as tarCreate } from "tar";
import { isMcpPlugin, type GuildPlugin } from "../src/types.js";
import { mcpRegistryManifest, registryManifest } from "../src/bundle-manifest.js";

const CATALOG_FORMAT = "guild-plugin-catalog/1";

function die(message: string): never {
  console.error(`guild-plugin: ${message}`);
  process.exit(1);
}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string | true> } {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function flag(flags: Record<string, string | true>, name: string): string | undefined {
  const value = flags[name];
  return typeof value === "string" ? value : undefined;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function packFiles(files: Record<string, Buffer | string>): Buffer {
  const dir = mkdtempSync(path.join(tmpdir(), "guild-plugin-"));
  try {
    for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
    const out = path.join(dir, "bundle.tar.gz");
    tarCreate({ sync: true, gzip: true, cwd: dir, file: out, portable: true }, Object.keys(files));
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** manifest.json out of a .guildplugin, read without unpacking to disk. */
function bundleManifest(bytes: Buffer): Record<string, unknown> {
  const tar = gunzipSync(bytes);
  for (let off = 0; off + 512 <= tar.length; ) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    const body = tar.subarray(off + 512, off + 512 + size);
    if (name === "manifest.json" || name === "./manifest.json") return JSON.parse(body.toString("utf8"));
    off += 512 + Math.ceil(size / 512) * 512;
  }
  die("the bundle has no manifest.json");
}

async function pack(positional: string[], flags: Record<string, string | true>): Promise<void> {
  const entry = path.resolve(positional[0] ?? "src/integration.ts");
  if (!existsSync(entry)) die(`no plugin entry at ${entry}`);
  const outDir = path.resolve(flag(flags, "out") ?? "dist");
  mkdirSync(outDir, { recursive: true });
  const built = await Bun.build({ entrypoints: [entry], target: "node", format: "esm", minify: false });
  if (!built.success) {
    for (const log of built.logs) console.error(log);
    die("build failed");
  }
  const code = Buffer.from(await built.outputs[0]!.arrayBuffer());
  const codePath = path.join(outDir, "plugin.js");
  writeFileSync(codePath, code);
  const mod = (await import(`${pathToFileURL(codePath).href}?t=${Date.now()}`)) as { default?: GuildPlugin };
  const plugin = mod.default;
  if (plugin?.manifest === undefined) die(`${entry} has no default plugin export`);
  let files: Record<string, Buffer | string>;
  if (isMcpPlugin(plugin)) {
    // An MCP plugin runs no code: the bundle is its manifest and pages.
    rmSync(codePath, { force: true });
    files = { "manifest.json": `${JSON.stringify(mcpRegistryManifest(plugin.manifest), null, 2)}\n` };
  } else {
    if (typeof plugin.execute !== "function" || typeof plugin.testConnection !== "function") {
      die("the plugin export lacks execute or testConnection");
    }
    files = {
      "manifest.json": `${JSON.stringify(registryManifest(plugin.manifest), null, 2)}\n`,
      "plugin.js": code,
    };
  }
  const m = plugin.manifest;
  // The nearest logo.svg and README.md from the entry's folder up to the
  // working directory (a plugin folder keeps them beside src/).
  const stop = path.resolve(".");
  for (const name of ["logo.svg", "README.md"]) {
    for (let dir = path.dirname(entry); ; dir = path.dirname(dir)) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) {
        files[name] = readFileSync(candidate);
        break;
      }
      if (dir === stop || dir === path.dirname(dir) || !dir.startsWith(stop)) break;
    }
  }
  const bytes = packFiles(files);
  const out = path.join(outDir, `${m.name}-${m.version}.guildplugin`);
  writeFileSync(out, bytes);
  console.log(`${out}\nsha256 ${sha256(bytes)}`);
}

async function request(server: string, token: string, method: string, url: string, body?: unknown): Promise<unknown> {
  const init: RequestInit = { method, headers: { authorization: `Bearer ${token}` } };
  if (body instanceof Buffer) {
    init.body = body;
    (init.headers as Record<string, string>)["content-type"] = "application/gzip";
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  const res = await fetch(`${server.replace(/\/+$/, "")}${url}`, init);
  const text = await res.text();
  if (!res.ok) die(`${method} ${url}: ${res.status} ${text}`);
  return text === "" ? null : JSON.parse(text);
}

async function publish(positional: string[], flags: Record<string, string | true>): Promise<void> {
  const file = positional[0] ?? die("publish needs a .guildplugin path");
  const server = flag(flags, "server") ?? process.env["GUILD_SERVER"] ?? die("no --server (or $GUILD_SERVER)");
  const token = flag(flags, "token") ?? process.env["GUILD_TOKEN"] ?? die("no --token (or $GUILD_TOKEN)");
  const bytes = readFileSync(file);
  const m = bundleManifest(bytes);
  const slug = String(m["slug"]);
  const version = String(m["version"]);
  const q = `slug=${encodeURIComponent(slug)}&version=${encodeURIComponent(version)}`;
  await request(server, token, "POST", `/api/v1/registry/integration?${q}`, bytes);
  console.log(`published ${slug} ${version} (sha256 ${sha256(bytes)})`);
  if (flags["approve"] === true) {
    await request(server, token, "POST", `/api/v1/registry/integration/${slug}/review`, {
      status: "approved",
      reviewed_version: version,
      reviewed_bundle_sha256: sha256(bytes),
    });
    await request(server, token, "POST", `/api/v1/registry/integration/${slug}/install?version=${version}`);
    console.log(`approved and installed ${slug} ${version}`);
  }
}

interface CatalogVersion {
  version: string;
  sha256: string;
  bundle: string;
  published_at: string;
}

interface CatalogPlugin {
  slug: string;
  title: string;
  summary: string;
  publisher: string;
  categories: string[];
  traits: string[];
  docs_url: string | null;
  versions: CatalogVersion[];
}

function catalogAdd(positional: string[], flags: Record<string, string | true>): void {
  const file = positional[0] ?? die("catalog add needs a .guildplugin path");
  const indexPath = path.resolve(flag(flags, "index") ?? "index.json");
  const bytes = readFileSync(file);
  const m = bundleManifest(bytes);
  const slug = String(m["slug"]);
  const version = String(m["version"]);
  let bundle = flag(flags, "url");
  if (bundle === undefined) {
    const dir = path.join(path.dirname(indexPath), "bundles");
    mkdirSync(dir, { recursive: true });
    const name = `${slug}-${version}.guildplugin`;
    copyFileSync(file, path.join(dir, name));
    bundle = `bundles/${name}`;
  }
  const index = existsSync(indexPath)
    ? (JSON.parse(readFileSync(indexPath, "utf8")) as { format: string; name?: string; plugins: CatalogPlugin[] })
    : { format: CATALOG_FORMAT, name: flag(flags, "name") ?? path.basename(path.dirname(indexPath)), plugins: [] };
  if (flag(flags, "name") !== undefined) index.name = flag(flags, "name");
  if (index.format !== CATALOG_FORMAT) die(`${indexPath} is not a ${CATALOG_FORMAT} index`);
  let entry = index.plugins.find((p) => p.slug === slug);
  if (entry === undefined) {
    entry = {
      slug,
      title: "",
      summary: "",
      publisher: "",
      categories: [],
      traits: [],
      docs_url: null,
      versions: [],
    };
    index.plugins.push(entry);
  }
  entry.title = String(m["title"] ?? slug);
  entry.summary = String(m["summary"] ?? "");
  entry.publisher = String(m["publisher"] ?? "");
  entry.categories = Array.isArray(m["categories"]) ? (m["categories"] as string[]) : [];
  entry.traits = Object.keys((m["traits"] as Record<string, string> | undefined) ?? {});
  entry.docs_url = typeof m["docs_url"] === "string" ? (m["docs_url"] as string) : null;
  entry.versions = entry.versions.filter((v) => v.version !== version);
  entry.versions.unshift({ version, sha256: sha256(bytes), bundle, published_at: new Date().toISOString() });
  index.plugins.sort((a, b) => a.slug.localeCompare(b.slug));
  writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`);
  console.log(`${indexPath}: ${slug} ${version} -> ${bundle}`);
}

const [command, ...rest] = process.argv.slice(2);
const { positional, flags } = parseArgs(rest);
switch (command) {
  case "pack":
    await pack(positional, flags);
    break;
  case "publish":
    await publish(positional, flags);
    break;
  case "catalog":
    if (positional[0] !== "add")
      die("usage: guild-plugin catalog add <bundle> [--index index.json] [--url URL] [--name NAME]");
    catalogAdd(positional.slice(1), flags);
    break;
  default:
    console.error(
      readFileSync(new URL(import.meta.url), "utf8")
        .split("\n")
        .slice(1, 19)
        .join("\n")
        .replace(/^\/\/ ?/gm, ""),
    );
    process.exit(command === undefined || command === "help" ? 0 : 1);
}
