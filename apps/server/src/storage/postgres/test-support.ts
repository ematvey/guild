import { randomUUID } from "node:crypto";
import pg from "pg";
import type { PostgresExecutor } from "./executor.js";

/**
 * Admin connection for disposable test databases: `GUILD_TEST_PG_URL`, the
 * same Postgres every server test suite and the storage benchmark use.
 *
 * Tests never write to that database itself; it only hosts
 * `CREATE DATABASE` / `DROP DATABASE` for throwaway `guild_durable_test_*`
 * databases.
 */
export const DURABLE_TEST_ADMIN_URL =
  process.env.GUILD_TEST_PG_URL ?? "postgres://guild:guild@localhost:5432/guild";

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
    // WITH (FORCE) terminates blocking backends; under parallel-suite load a
    // backend can exit while the signal lands — the drop then fails with
    // "permission denied to terminate process" once. Retry, then force
    // terminate + drop explicitly.
    for (let attempt = 1; ; attempt++) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        return;
      } catch (error) {
        if (attempt >= 4) throw error;
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("terminate process")) throw error;
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }
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
