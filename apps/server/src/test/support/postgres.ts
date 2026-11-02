// Disposable Postgres databases for the server suites: one factory every
// stack harness builds on (create, migrate, seed pool, drop), plus the
// durable-storage helpers.

import { randomUUID } from "node:crypto";
import pg from "pg";
import type { PostgresExecutor } from "../../storage/postgres/executor.js";
import { applyPlatformMigrations } from "../../platform/migrations.js";

/**
 * Admin connection for disposable test databases: `GUILD_TEST_PG_URL`, the
 * same Postgres every server test suite and the storage benchmark use.
 *
 * Tests never write to that database itself; it only hosts
 * `CREATE DATABASE` / `DROP DATABASE` for throwaway `guild_durable_test_*`
 * databases.
 */
export const DURABLE_TEST_ADMIN_URL = process.env.GUILD_TEST_PG_URL ?? "postgres://guild:guild@localhost:5432/guild";

/** The admin URL every stack harness creates its databases through. */
export const TEST_ADMIN_URL = DURABLE_TEST_ADMIN_URL;

/** A short random hex suffix for disposable names. */
export function testSuffix(): string {
  return randomUUID().replaceAll("-", "").slice(0, 12);
}

/** A disposable database with every platform migration applied. */
export interface TestDatabase {
  readonly name: string;
  readonly url: string;
  /** Pool on the disposable database (seeding/preparation) — never on the
   *  shared database the admin URL points at. */
  readonly pool: pg.Pool;
  /** Ends the seeding pool and drops the database. */
  drop(): Promise<void>;
}

/** Creates `<prefix><suffix>` and applies the platform migrations through
 *  the production startup path (same filename order, same schema_history
 *  tracking). */
export async function createTestDatabase(
  prefix: string,
  options: { poolMax?: number; suffix?: string; migrate?: boolean } = {},
): Promise<TestDatabase> {
  const name = `${prefix}${options.suffix ?? testSuffix()}`;
  const admin = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 1, idleTimeoutMillis: 2000 });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(TEST_ADMIN_URL);
  url.pathname = `/${name}`;
  if (options.migrate !== false) {
    const migrationPool = new pg.Pool({ connectionString: url.toString(), max: 2, idleTimeoutMillis: 2000 });
    try {
      await applyPlatformMigrations(migrationPool);
    } finally {
      await migrationPool.end();
    }
  }
  const pool = new pg.Pool({ connectionString: url.toString(), max: options.poolMax ?? 4, idleTimeoutMillis: 2000 });
  let dropped = false;
  return {
    name,
    url: url.toString(),
    pool,
    drop: async () => {
      if (dropped) return;
      dropped = true;
      await pool.end();
      const dropper = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 1, idleTimeoutMillis: 2000 });
      try {
        await dropTestDatabase(dropper, name);
      } finally {
        await dropper.end();
      }
    },
  };
}

export interface DisposableDatabase {
  readonly name: string;
  readonly url: string;
}

export function durableTestDatabaseName(): string {
  return `guild_durable_test_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export async function createDisposableDatabase(): Promise<DisposableDatabase> {
  const name = durableTestDatabaseName();
  const admin = new pg.Pool({ connectionString: DURABLE_TEST_ADMIN_URL, max: 1 });
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
  } finally {
    await admin.end();
  }
  const url = new URL(DURABLE_TEST_ADMIN_URL);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

/** Drops a test database. WITH (FORCE) terminates blocking backends; under
 *  parallel-suite load a backend can exit as the signal lands, or be one the
 *  test role may not signal (an autovacuum worker on a freshly migrated
 *  database), and the drop fails with "permission denied to terminate
 *  process". That failure is transient: retry with a short backoff. */
export async function dropTestDatabase(admin: { query(sql: string): Promise<unknown> }, name: string): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      return;
    } catch (error) {
      if (attempt >= 8) throw error;
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes("terminate process")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

export async function dropDisposableDatabase(name: string): Promise<void> {
  const admin = new pg.Pool({ connectionString: DURABLE_TEST_ADMIN_URL, max: 1 });
  try {
    await dropTestDatabase(admin, name);
  } finally {
    await admin.end();
  }
}

/** Drop every durable table so migrations rebuild a pristine schema in place. */
export async function resetDurableTables(executor: PostgresExecutor): Promise<void> {
  for (const table of [
    "live_projection_repairs",
    "document_revisions",
    "documents",
    "submissions",
    "tasks",
    "entries",
    "conversations",
    "record_ids",
    "durable_commits",
    "durable_metadata",
    "durable_schema",
  ]) {
    await executor.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
}
