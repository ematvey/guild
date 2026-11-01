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

export function createPlatformPool(databaseUrl: string, poolMax = 10): pg.Pool {
  installBigintNumberParser();
  // Short idle timeout: suites (and redeploys) must release their slots
  // promptly on the shared dev server's connection budget.
  return new pg.Pool({ connectionString: databaseUrl, max: poolMax, idleTimeoutMillis: 2000 });
}

/** Runs `fn` inside one transaction on a dedicated pooled client: COMMIT
 *  when it resolves, ROLLBACK (best effort; the original error wins) when it
 *  throws. */
export async function withTransaction<T>(pool: PlatformPool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
