import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { registerStorageConformance } from "@earendil-works/pi-durable/testing";
import type { StorageConformanceProvider } from "@earendil-works/pi-durable/testing";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import { PgPoolDatabase, PostgresDurableStorage } from "../../storage/postgres/index.js";
import {
  createDisposableDatabase,
  dropDisposableDatabase,
  resetDurableTables,
  type DisposableDatabase,
} from "../../storage/postgres/test-support.js";

const shared: { database: DisposableDatabase | undefined } = { database: undefined };

afterAll(async () => {
  if (shared.database !== undefined) await dropDisposableDatabase(shared.database.name);
});

const withStorage: StorageConformanceProvider = async (use) => {
  shared.database ??= await createDisposableDatabase();
  const pool = new pg.Pool({ connectionString: shared.database.url, max: 2 });
  const db = new PgPoolDatabase(pool);
  let storage: PostgresDurableStorage | undefined;
  try {
    await resetDurableTables(db);
    storage = await PostgresDurableStorage.open(db);
    try {
      await use(storage);
    } finally {
      await storage.close(BACKGROUND_CONTEXT);
    }
  } finally {
    if (storage === undefined) await pool.end().catch(() => {});
  }
};

registerStorageConformance({ describe, expect, it }, "Postgres durable storage conformance", withStorage);
