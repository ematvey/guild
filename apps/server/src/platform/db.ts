// Postgres pool for the platform tables (one per process, design decision
// 5: same database as the durable storage). BIGINT columns parse as numbers
// — the platform stores only safe-range integers (auth_generation,
// size_bytes).

import pg from "pg";
import type { Logger } from "pino";

let bigintParserInstalled = false;
function installBigintNumberParser(): void {
  if (bigintParserInstalled) return;
  bigintParserInstalled = true;
  pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number(value));
}

export type PlatformPool = pg.Pool;
export type PoolClient = pg.PoolClient;

export function createPlatformPool(databaseUrl: string, poolMax = 10, log?: Pick<Logger, "warn">): pg.Pool {
  installBigintNumberParser();
  // Short idle timeout: suites (and redeploys) must release their slots
  // promptly on the shared dev server's connection budget.
  const pool = new pg.Pool({ connectionString: databaseUrl, max: poolMax, idleTimeoutMillis: 2000 });
  // pg removes a failed idle client before emitting this event. Handle it
  // so the next query can acquire a fresh client when Postgres is back.
  pool.on("error", (error) => log?.warn({ err: error }, "idle PostgreSQL connection lost"));
  return pool;
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
