// Guards for the record columns: JSON text, never cast to jsonb. JSONB rejects
// U+0000 and lone surrogates, so a cast on a stored record turns a tool result
// with binary bytes into a failed read (the context meter broke this way).

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { jsonbText, recordJsonText, sanitizeText } from "../platform/domain/text.js";

const SRC = path.resolve(process.cwd(), "src");

/** The durable migration file keeps its historical v5 statement, which v6
 *  replaces; it runs on an empty table and is not a read path. */
const ALLOWED = new Set([path.join(SRC, "storage/postgres/migrations.ts")]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== "test") out.push(...sourceFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("record text", () => {
  it("is never cast to jsonb outside the retired migration", () => {
    const offenders = sourceFiles(SRC)
      .filter((file) => !ALLOWED.has(file))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .map((line, index) => ({ line, index: index + 1 }))
          .filter(({ line }) => /\brecord::jsonb\b/.test(line))
          .map(({ index }) => `${path.relative(SRC, file)}:${index}`),
      );
    expect(offenders).toEqual([]);
  });

  it("replaces U+0000 and keeps the rest of the text", () => {
    expect(sanitizeText("PK\u0000binary")).toBe("PK\uFFFDbinary");
    expect(sanitizeText("plain")).toBe("plain");
    expect(sanitizeText("emoji 🦷 and \u0000")).toBe("emoji 🦷 and \uFFFD");
  });

  it("keeps a lone surrogate in a record and removes it for jsonb", () => {
    const value = { text: "a\ud83db" };
    expect(recordJsonText(value)).toContain("\\ud83d");
    expect(jsonbText(value)).toContain("\ufffd");
  });
});
