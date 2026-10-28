// Postgres pool for the platform tables (one per process, design decision
// 5: same database as the durable storage). BIGINT columns parse as numbers
// — the platform stores only safe-range integers (auth_generation,
// size_bytes).

import pg from "pg";

import { sanitizeText } from "./domain/text.js";

let bigintParserInstalled = false;
function installBigintNumberParser(): void {
  if (bigintParserInstalled) return;
  bigintParserInstalled = true;
  pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number(value));
}

export type PlatformPool = pg.Pool;
export type PoolClient = pg.PoolClient;

/** JSON text for a jsonb column or a ::jsonb parameter. Postgres jsonb
 *  rejects U+0000 and a lone surrogate. JSON.stringify escapes a lone
 *  surrogate as \udXXX and leaves U+0000 in the text, so every string goes
 *  through the record-text sanitizer and is made well-formed first. Clean
 *  input passes through byte-identical. */
export function jsonbText(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "string" ? sanitizeText(item).toWellFormed() : item);
}

export function createPlatformPool(databaseUrl: string, poolMax = 10): pg.Pool {
  installBigintNumberParser();
  // Short idle timeout: suites (and redeploys) must release their slots
  // promptly on the shared dev server's connection budget.
  return new pg.Pool({ connectionString: databaseUrl, max: poolMax, idleTimeoutMillis: 2000 });
}
