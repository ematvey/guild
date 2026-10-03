import pg from "pg";
import type { PostgresDatabase, PostgresExecutor, PostgresRow } from "./executor.js";

// node-postgres returns BIGINT columns as strings by default; durable storage
// ids and sequences are always within JS's safe integer range, so parse them
// as numbers. This is a module-global parser setting in node-postgres.
let bigintParserInstalled = false;
function installBigintNumberParser(): void {
  if (bigintParserInstalled) return;
  bigintParserInstalled = true;
  pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => Number(value));
}

interface Queryable {
  query(sql: string, params?: readonly unknown[]): Promise<{ rows: PostgresRow[] }>;
}

const executorFor = (client: Queryable): PostgresExecutor => ({
  query: async <T extends PostgresRow>(sql: string, params?: readonly unknown[]) => {
    const result = await client.query(sql, params === undefined ? [] : [...params]);
    return result.rows as T[];
  },
});

/**
 * Postgres facade over a `pg` connection pool.
 *
 * `transaction` and `readTransaction` run on a dedicated client so their
 * queries share one connection; the pool serves plain queries concurrently.
 */
export class PgPoolDatabase implements PostgresDatabase {
  private readonly pool: pg.Pool;

  constructor(pool: pg.Pool) {
    installBigintNumberParser();
    this.pool = pool;
  }

  query<T extends PostgresRow = PostgresRow>(sql: string, params?: readonly unknown[]): Promise<T[]> {
    return executorFor(this.pool).query<T>(sql, params);
  }

  async transaction<T>(callback: (tx: PostgresExecutor) => Promise<T>): Promise<T> {
    return this.isolatedTransaction(callback, "BEGIN");
  }

  async readTransaction<T>(callback: (tx: PostgresExecutor) => Promise<T>): Promise<T> {
    return this.isolatedTransaction(callback, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  }

  private async isolatedTransaction<T>(
    callback: (tx: PostgresExecutor) => Promise<T>,
    beginSql: string,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query(beginSql);
      try {
        const result = await callback(executorFor(client));
        await client.query("COMMIT");
        return result;
      } catch (error) {
        try {
          await client.query("ROLLBACK");
        } catch (rollbackError) {
          // Never mask the callback error with a failed rollback.
          throw new AggregateError([error, rollbackError], "Durable Postgres transaction rollback failed");
        }
        throw error;
      }
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
