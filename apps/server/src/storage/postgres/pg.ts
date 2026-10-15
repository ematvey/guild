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

// --- Transient-failure handling -------------------------------------------------
//
// The durable session is fail-stop: the first storage error seals it, and
// every chat in the process dies with it until restart. The adapter is the
// layer pi-durable delegates retries to, so connection-level failures are
// classified here and retried before they can reach the session guard.

/** Postgres error codes that mean "the connection or backend is gone or not
 *  accepting work yet" — a fresh attempt on a healthy connection survives
 *  them. Statement timeouts (57014) and cancellations are excluded: a
 *  genuinely slow or cancelled statement must not loop. */
const TRANSIENT_PG_CODES = new Set([
  "08000", // connection_exception
  "08001", // sqlclient_unable_to_establish_sqlconnection
  "08003", // connection_does_not_exist
  "08004", // sqlserver_rejected_establishment_of_sqlconnection
  "08006", // connection_failure
  "53300", // too_many_connections
  "57P01", // admin_shutdown
  "57P02", // crash_shutdown
  "57P03", // cannot_connect_now
  "57P05", // idle_in_transaction_session_timeout
]);

const TRANSIENT_MESSAGE =
  /connection terminated|connection ended|server closed the connection|the database system is starting up|terminating connection|connection refused|connection reset|socket hang up|write ECONN|read ECONN/i;

export function isTransientDbError(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.some(isTransientDbError);
  if (error === null || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    if (TRANSIENT_PG_CODES.has(code)) return true;
    if (["ECONNRESET", "ECONNREFUSED", "EPIPE", "ETIMEDOUT", "ECONNABORTED"].includes(code)) return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return TRANSIENT_MESSAGE.test(message);
}

export const RETRY_DELAYS_MS = [250, 1_000];

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function withDbRetries<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= RETRY_DELAYS_MS.length || !isTransientDbError(error)) throw error;
      await sleep(RETRY_DELAYS_MS[attempt]!);
    }
  }
}

/** Server-side bounds for one durable write transaction: every commit
 *  serializes on the durable_metadata row, so a transaction that stalls
 *  (dead socket, lost backend mid-commit) must die instead of holding that
 *  lock — and the whole durable layer with it — indefinitely. */
const TX_IDLE_IN_TRANSACTION_TIMEOUT = "30s";
const TX_STATEMENT_TIMEOUT = "30s";
/** Client-side stall bound: a connection whose socket went silent never
 *  delivers the server-side timeout, so the watchdog destroys it and the
 *  pending query errors (the commit's retry + adoption then resolves the
 *  ambiguous outcome). */
const TX_WATCHDOG_MS = 45_000;

/** Destroys the client's socket so a stalled query settles as an error
 *  instead of hanging forever; the broken client leaves the pool. */
function destroyClient(client: Queryable, reason: Error): void {
  const stream = (client as unknown as { connection?: { stream?: { destroy(error?: Error): void } } }).connection?.stream;
  stream?.destroy(reason);
}

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
    // Plain reads: idempotent, so a connection-level failure retries on a
    // fresh checkout instead of failing the durable session.
    return withDbRetries(async () => executorFor(this.pool).query<T>(sql, params));
  }

  async transaction<T>(callback: (tx: PostgresExecutor) => Promise<T>): Promise<T> {
    return this.isolatedTransaction(callback, "BEGIN", true);
  }

  async readTransaction<T>(callback: (tx: PostgresExecutor) => Promise<T>): Promise<T> {
    // Read-only snapshot: idempotent as a whole, so a connection-level
    // failure retries instead of failing the durable session.
    return withDbRetries(() => this.isolatedTransaction(callback, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", false));
  }

  private async isolatedTransaction<T>(
    callback: (tx: PostgresExecutor) => Promise<T>,
    beginSql: string,
    guarded: boolean,
  ): Promise<T> {
    const client = await this.pool.connect();
    let watchdog: NodeJS.Timeout | undefined;
    let broken: Error | undefined;
    try {
      await client.query(beginSql);
      if (guarded) {
        // Transaction-scoped (SET LOCAL): the bounds apply to this write
        // transaction only, never to the pool's other work.
        await client.query(`SET LOCAL idle_in_transaction_session_timeout = '${TX_IDLE_IN_TRANSACTION_TIMEOUT}'`);
        await client.query(`SET LOCAL statement_timeout = '${TX_STATEMENT_TIMEOUT}'`);
      }
      let execute: Promise<T>;
      if (guarded) {
        execute = new Promise<T>((resolve, reject) => {
          watchdog = setTimeout(() => {
            broken = new Error("durable write transaction aborted: the connection stalled past the watchdog");
            destroyClient(client, broken);
            reject(broken);
          }, TX_WATCHDOG_MS);
          watchdog.unref?.();
          callback(executorFor(client)).then(resolve, reject);
        });
      } else {
        execute = callback(executorFor(client));
      }
      const result = await execute;
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
    } finally {
      clearTimeout(watchdog);
      client.release(broken);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
