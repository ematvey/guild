import { randomUUID } from "node:crypto";
import pg from "pg";
import type { PostgresExecutor } from "./executor.js";

/**
 * Admin connection settings for disposable test databases.
 *
 * Tests never write to the configured database itself; it only hosts
 * `CREATE DATABASE` / `DROP DATABASE` for throwaway `guild_durable_test_*`
 * databases. Override with `DURABLE_TEST_DATABASE_URL`.
 */
export const DURABLE_TEST_ADMIN_URL =
  process.env.DURABLE_TEST_DATABASE_URL ?? "postgres://guild:guild@localhost:5432/guild";

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

export async function dropDisposableDatabase(name: string): Promise<void> {
  const admin = new pg.Pool({ connectionString: DURABLE_TEST_ADMIN_URL, max: 1 });
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}

/** Drop every durable table so migrations rebuild a pristine schema in place. */
export async function resetDurableTables(executor: PostgresExecutor): Promise<void> {
  for (const table of [
    "document_revisions",
    "documents",
    "submissions",
    "tasks",
    "entries",
    "conversations",
    "record_ids",
    "durable_metadata",
    "durable_schema",
  ]) {
    await executor.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
  }
}
