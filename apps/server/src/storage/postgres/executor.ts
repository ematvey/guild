/** Values a Postgres adapter delivers for durable storage columns. */
export type PostgresValue = null | boolean | number | string | object;

/** One result row keyed by column name. */
export interface PostgresRow {
  readonly [column: string]: PostgresValue | undefined;
}

/**
 * SQL operations over one Postgres connection or transaction.
 *
 * Params are positional (`$1`, `$2`, ...). Adapters must deliver BIGINT
 * columns as JS numbers (safe-integer range), BOOLEAN columns as booleans,
 * and JSON/JSONB-typed TEXT columns as strings.
 */
export interface PostgresExecutor {
  query<T extends PostgresRow = PostgresRow>(sql: string, params?: readonly unknown[]): Promise<T[]>;
}

/**
 * Database facade required by the portable durable storage core.
 *
 * `transaction` gives the callback an executor bound to one read/write
 * transaction; the promise settles after commit or rollback, and adapters
 * must queue unrelated work until the transaction finishes.
 * `readTransaction` gives one read-only snapshot transaction: every query
 * inside observes the same committed state even when commits land
 * concurrently, which keeps multi-query reads from tearing.
 */
export interface PostgresDatabase extends PostgresExecutor {
  transaction<T>(callback: (tx: PostgresExecutor) => Promise<T>): Promise<T>;
  readTransaction<T>(callback: (tx: PostgresExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
