// Architecture layer test: enforces the one-directional dependency graph
//
//   platform/http/* → services (harness/*, chats/*, hub/*, machines/*,
//                      platform/notify) → DAL (platform/store/*)
//                      → infra (platform/db, platform/crypto, platform/time)
//
// The DAL must not import upward (services, HTTP layer, fastify); the
// service folders must not import the HTTP layer or fastify.
// platform/http/* sits on top and is exempt from the upward rules.

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Relative-to-src prefixes a DAL file may never import (segment-exact:
 *  `platform/http` does not match `platform/httpx`). */
const BANNED_FOR_DAL = ["platform/http", "hub", "harness", "machines", "chats"];
/** The HTTP layer + fastify are off limits for the service folders. */
const BANNED_FOR_SERVICES = ["platform/http", "fastify"];

const DAL_DIRS = [path.join(SRC, "platform", "store")];

function* tsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* tsFiles(full);
    else if (entry.name.endsWith(".ts")) yield full;
  }
}

/** All static import/export-from specifiers in a source file. */
function importSpecifiers(code: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(/(?:^|\n)\s*(?:import|export)[^"'`]*?from\s*"([^"]+)"/g)) {
    out.push(m[1]!);
  }
  for (const m of code.matchAll(/(?:^|\n)\s*import\s*"([^"]+)"/g)) {
    out.push(m[1]!);
  }
  return out;
}

/** Resolves a specifier to a path relative to `src` (POSIX separators), or
 *  returns the bare specifier unchanged for package imports. */
function resolveImport(specifier: string, fromFile: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const target = path.resolve(path.dirname(fromFile), specifier);
  let rel = path.relative(SRC, target).split(path.sep).join("/");
  if (rel.endsWith(".js")) rel = rel.slice(0, -3) + ".ts";
  else if (!rel.endsWith(".ts")) rel = rel + ".ts"; // extensionless: file or dir index
  return rel;
}

/** True when the src-relative import target lives under one of the banned
 *  prefixes (path-segment exact). Bare package specifiers match by name or
 *  `name/` prefix. */
function isBanned(target: string, banned: string[]): boolean {
  return banned.some((prefix) =>
    target === prefix || target.startsWith(`${prefix}/`),
  );
}

function violations(dir: string, banned: string[]): string[] {
  const found: string[] = [];
  for (const file of tsFiles(dir)) {
    for (const spec of importSpecifiers(readFileSync(file, "utf8"))) {
      const target = resolveImport(spec, file);
      if (isBanned(target, banned)) {
        found.push(
          `${path.relative(SRC, file)} imports "${spec}" (resolves to ${target})`,
        );
      }
    }
  }
  return found.sort();
}

describe("arch layers", () => {
  it("DAL (platform/store/*) imports nothing upward", () => {
    for (const dir of DAL_DIRS) {
      expect(violations(dir, BANNED_FOR_DAL)).toEqual([]);
    }
  });

  for (const dir of ["harness", "chats", "hub", "machines"]) {
    it(`service folder ${dir}/ imports no fastify or platform/http`, () => {
      expect(violations(path.join(SRC, dir), BANNED_FOR_SERVICES)).toEqual([]);
    });
  }

  it("platform/http/* imports no PlatformContext (register.ts composition glue excepted)", () => {
    const found: string[] = [];
    for (const file of tsFiles(path.join(SRC, "platform", "http"))) {
      const rel = path.relative(SRC, file);
      if (rel === "platform/http/register.ts") continue;
      const targets = importSpecifiers(readFileSync(file, "utf8")).map((s) => resolveImport(s, file));
      if (targets.includes("platform/context.ts")) found.push(rel);
    }
    expect(found.sort()).toEqual([]);
  });
});
