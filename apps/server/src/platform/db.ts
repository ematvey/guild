// Postgres pool for the platform tables (one per process, design decision
// 5: same database as the durable storage). BIGINT columns parse as numbers
// — the platform stores only safe-range integers (auth_generation,
// size_bytes).

import pg from "pg";

let bigintParserInstalled = false;
function installBigintNumberParser(): void {
  if (bigintParserInstalled) return;
  bigintParserInstalled = true;
  pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number(value));
}

export type PlatformPool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPlatformPool(databaseUrl: string): pg.Pool {
  installBigintNumberParser();
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}
