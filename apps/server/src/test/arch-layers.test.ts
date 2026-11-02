// Architecture layer test: enforces the one-directional dependency graph
//
//   composition root (app.ts, composition.ts, index.ts)
//     → platform/http/* (routes, the member socket, web serving)
//     → services (agents, chats, execpolicy, harness, hub, integrations,
//                 machines, push, sandbox, worker)
//     → DAL (platform/store/*, platform/domain/*, platform/provider/*, the
//            platform root modules, and the agents lane's agents/store/*)
//     → durable storage (storage/postgres) and infra (platform/db, …)
//
// No layer imports the composition root (worker/main.ts is the worker
// process's own root and builds its runtime from the same parts). The DAL
// imports nothing upward; the service folders import no HTTP layer and no
// fastify. platform/route-contexts.ts is the HTTP-facing contract the route
// groups are typed to: it names service types (type-only) and constructs
// nothing, so it sits outside the DAL. agents/store/* is the agents lane's
// data access: it holds to the DAL rules and may import only its siblings
// and the lane's types (agents/types.ts). Durable tables are read through
// storage/postgres/queries.ts, a leaf module the DAL may import; every SQL
// statement against a platform table lives in the DAL.

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));
const MIGRATIONS = fileURLToPath(new URL("../../migrations", import.meta.url));

const SERVICE_DIRS = [
  "agents",
  "chats",
  "execpolicy",
  "harness",
  "hub",
  "integrations",
  "machines",
  "push",
  "sandbox",
  "worker",
] as const;

/** Every top-level entry of src/ and the layer it belongs to: a new folder
 *  or root file must be placed here before the suite passes. */
const TOP_LEVEL: Record<string, "root" | "platform" | "service" | "storage" | "test"> = {
  "app.ts": "root",
  "composition.ts": "root",
  "index.ts": "root",
  "config.ts": "platform",
  platform: "platform",
  storage: "storage",
  test: "test",
  ...Object.fromEntries(SERVICE_DIRS.map((dir) => [dir, "service" as const])),
};

const COMPOSITION_ROOT = ["composition.ts", "app.ts", "index.ts"];

/** The durable read surface the DAL may use. */
const DURABLE_QUERIES = "storage/postgres/queries.ts";

/** Relative-to-src prefixes a DAL file may never import (segment-exact:
 *  `platform/http` does not match `platform/httpx`). */
const BANNED_FOR_DAL = [
  ...COMPOSITION_ROOT,
  "platform/http",
  "platform/route-contexts.ts",
  "storage",
  "fastify",
  ...SERVICE_DIRS,
];
/** The HTTP layer, the composition root and fastify are off limits for
 *  the service folders. */
const BANNED_FOR_SERVICES = ["platform/http", "fastify", ...COMPOSITION_ROOT];

/** The agents lane's data access, inside the agents service folder. */
const AGENTS_DAL = "agents/store";

/** The agents-folder module the agents DAL may import: the lane's row and
 *  wire types. */
const AGENTS_TYPES = "agents/types.ts";

/** DAL files: the store facades, the domain and provider modules, the
 *  platform root modules except the HTTP-facing route contexts, and the
 *  agents lane's store modules. */
function dalFiles(): string[] {
  const files = [
    ...tsFiles(path.join(SRC, "platform", "store")),
    ...tsFiles(path.join(SRC, "platform", "domain")),
    ...tsFiles(path.join(SRC, "platform", "provider")),
    ...tsFiles(path.join(SRC, AGENTS_DAL)),
  ];
  for (const entry of readdirSync(path.join(SRC, "platform"))) {
    const full = path.join(SRC, "platform", entry);
    if (entry.endsWith(".ts") && entry !== "route-contexts.ts" && statSync(full).isFile()) files.push(full);
  }
  return files;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** All static import/export-from specifiers in a source file, with whether
 *  the statement is type-only. */
function imports(code: string): { specifier: string; typeOnly: boolean }[] {
  const out: { specifier: string; typeOnly: boolean }[] = [];
  for (const m of code.matchAll(/(?:^|\n)\s*(import|export)(\s+type)?[^"'`]*?from\s*"([^"]+)"/g)) {
    out.push({ specifier: m[3]!, typeOnly: m[2] !== undefined });
  }
  for (const m of code.matchAll(/(?:^|\n)\s*import\s*"([^"]+)"/g)) {
    out.push({ specifier: m[1]!, typeOnly: false });
  }
  return out;
}

/** Resolves a specifier to a path relative to `src` (POSIX separators), or
 *  returns the bare specifier unchanged for package imports. */
function resolveImport(specifier: string, fromFile: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const target = path.resolve(path.dirname(fromFile), specifier);
  let rel = path.relative(SRC, target).split(path.sep).join("/");
  if (rel.endsWith(".js")) rel = `${rel.slice(0, -3)}.ts`;
  else if (!rel.endsWith(".ts")) rel = `${rel}.ts`; // extensionless: file or dir index
  return rel;
}

/** True when the src-relative import target lives under one of the banned
 *  prefixes (path-segment exact). Bare package specifiers match by name or
 *  `name/` prefix. */
function isBanned(target: string, banned: readonly string[]): boolean {
  return banned.some((prefix) => target === prefix || target.startsWith(`${prefix}/`));
}

function violations(files: readonly string[], banned: readonly string[], allowed: readonly string[] = []): string[] {
  const found: string[] = [];
  for (const file of files) {
    for (const { specifier } of imports(readFileSync(file, "utf8"))) {
      const target = resolveImport(specifier, file);
      if (allowed.includes(target)) continue;
      if (isBanned(target, banned)) {
        found.push(`${path.relative(SRC, file)} imports "${specifier}" (resolves to ${target})`);
      }
    }
  }
  return found.sort();
}

/** The platform tables: every table the migrations create. */
function platformTables(): string[] {
  const tables = new Set<string>();
  for (const file of readdirSync(MIGRATIONS)) {
    if (!file.endsWith(".sql")) continue;
    const sql = readFileSync(path.join(MIGRATIONS, file), "utf8");
    for (const m of sql.matchAll(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+(?:public\.)?([a-z_]+)/gi)) {
      tables.add(m[1]!.toLowerCase());
    }
  }
  return [...tables].sort();
}

/** The pi-durable tables (storage/postgres/migrations.ts). */
const DURABLE_TABLES = ["tasks", "entries", "submissions", "documents", "durable_[a-z_]+"];

/** How many statements in `code` name one of `tables` after FROM, JOIN,
 *  INTO or UPDATE. */
function sqlHits(code: string, tables: readonly string[]): number {
  const pattern = new RegExp(`\\b(?:FROM|JOIN|INTO|UPDATE)\\s+(?:${tables.join("|")})\\b`, "g");
  return [...code.matchAll(pattern)].length;
}

describe("arch layers", () => {
  it("every top-level src entry belongs to a layer", () => {
    const unknown = readdirSync(SRC).filter((entry) => TOP_LEVEL[entry] === undefined);
    expect(unknown).toEqual([]);
  });

  it("DAL imports nothing upward", () => {
    const agentsDal = tsFiles(path.join(SRC, AGENTS_DAL)).map((file) =>
      path.relative(SRC, file).split(path.sep).join("/"),
    );
    expect(violations(dalFiles(), BANNED_FOR_DAL, [DURABLE_QUERIES, AGENTS_TYPES, ...agentsDal])).toEqual([]);
  });

  it("the agents DAL types module imports only the DAL", () => {
    const file = path.join(SRC, AGENTS_TYPES);
    expect(violations([file], BANNED_FOR_DAL)).toEqual([]);
  });

  it("the durable read surface is a leaf", () => {
    const file = path.join(SRC, DURABLE_QUERIES);
    const relative = imports(readFileSync(file, "utf8")).filter(({ specifier }) => specifier.startsWith("."));
    expect(relative).toEqual([]);
  });

  for (const dir of SERVICE_DIRS) {
    it(`service folder ${dir}/ imports no fastify, platform/http or composition root`, () => {
      expect(violations(tsFiles(path.join(SRC, dir)), BANNED_FOR_SERVICES)).toEqual([]);
    });
  }

  it("platform/ imports no composition root (register.ts composition glue excepted)", () => {
    const files = tsFiles(path.join(SRC, "platform")).filter(
      (file) => path.relative(SRC, file) !== "platform/http/register.ts",
    );
    expect(violations(files, COMPOSITION_ROOT)).toEqual([]);
  });

  it("platform/route-contexts.ts names service types only", () => {
    const file = path.join(SRC, "platform", "route-contexts.ts");
    const valueImports = imports(readFileSync(file, "utf8"))
      .filter(({ specifier, typeOnly }) => !typeOnly && isBanned(resolveImport(specifier, file), SERVICE_DIRS))
      .map(({ specifier }) => specifier);
    expect(valueImports).toEqual([]);
  });

  it("durable tables are queried only in storage/", () => {
    const found: string[] = [];
    for (const file of tsFiles(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (rel.startsWith("storage/") || rel.startsWith("test/")) continue;
      const hits = sqlHits(readFileSync(file, "utf8"), DURABLE_TABLES);
      if (hits > 0) found.push(`${rel}: ${hits}`);
    }
    expect(found.sort()).toEqual([]);
  });

  it("platform-table SQL lives only in the DAL", () => {
    const tables = platformTables();
    const dal = new Set(dalFiles().map((file) => path.relative(SRC, file).split(path.sep).join("/")));
    const found: string[] = [];
    for (const file of tsFiles(SRC)) {
      const rel = path.relative(SRC, file).split(path.sep).join("/");
      if (dal.has(rel) || rel.startsWith("storage/") || rel.startsWith("test/")) continue;
      const hits = sqlHits(readFileSync(file, "utf8"), tables);
      if (hits > 0) found.push(`${rel}: ${hits}`);
    }
    expect(found.sort()).toEqual([]);
  });
});
