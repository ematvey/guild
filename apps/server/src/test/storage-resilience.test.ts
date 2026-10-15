// Durable storage resilience: the fail-stop session means one storage error
// seals every conversation in the process, so the Postgres adapter must
// absorb transient connection failures (retry) and ambiguous commit
// outcomes (adoption through the durable_commits row) before they reach
// the session guard.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationRecord } from "@earendil-works/pi-durable";
import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";
import type { PostgresDatabase, PostgresExecutor, PostgresRow } from "../storage/postgres/index.js";
import { PgPoolDatabase, PostgresDurableStorage } from "../storage/postgres/index.js";
import {
  createDisposableDatabase,
  dropDisposableDatabase,
  resetDurableTables,
  type DisposableDatabase,
} from "../storage/postgres/test-support.js";

let database: DisposableDatabase | undefined;

afterAll(async () => {
  if (database !== undefined) await dropDisposableDatabase(database.name);
});

/** PostgresDatabase facade that throws a connection error for the next N
 *  operations of one kind, then delegates — simulates a transient blip. */
class FlakyDb implements PostgresDatabase {
  failTransactions = 0;
  failQueries = 0;

  constructor(private readonly inner: PgPoolDatabase) {}

  async query<T extends PostgresRow>(sql: string, params?: readonly unknown[]): Promise<T[]> {
    if (this.failQueries > 0) {
      this.failQueries--;
      throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
    }
    return this.inner.query<T>(sql, params);
  }

  async transaction<T>(callback: (tx: PostgresExecutor) => Promise<T>): Promise<T> {
    if (this.failTransactions > 0) {
      this.failTransactions--;
      throw Object.assign(new Error("server closed the connection unexpectedly"), { code: "ECONNRESET" });
    }
    return this.inner.transaction(callback);
  }

  async readTransaction<T>(callback: (tx: PostgresExecutor) => Promise<T>): Promise<T> {
    return this.inner.readTransaction(callback);
  }

  async close(): Promise<void> {
    await this.inner.close();
  }
}

async function withStorage(run: (storage: PostgresDurableStorage, db: FlakyDb) => Promise<void>): Promise<void> {
  database ??= await createDisposableDatabase();
  const pool = new pg.Pool({ connectionString: database.url, max: 2 });
  const db = new FlakyDb(new PgPoolDatabase(pool));
  try {
    await resetDurableTables(db);
    const storage = await PostgresDurableStorage.open(db);
    try {
      await run(storage, db);
    } finally {
      await storage.close(BACKGROUND_CONTEXT).catch(() => {});
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

const conversationWrite = (id: number) =>
  ({ type: "conversation", value: { id } }) as never as Parameters<PostgresDurableStorage["commit"]>[0][number];

describe("durable Postgres resilience", () => {
  it(
    "adopts an already-applied batch once the outcome became ambiguous",
    async () => {
      await withStorage(async (storage, db) => {
        const id = await storage.mintId();
        const writes = [conversationWrite(id)];
        const seq = await storage.commit(writes, BACKGROUND_CONTEXT);
        // Re-committing the same writes on a clean connection must reject
        // (the storage contract: the ID claim throws, no adoption).
        await expect(storage.commit(writes, BACKGROUND_CONTEXT)).rejects.toThrow("already belongs to conversation");
        // The same re-commit after a connection failure is ambiguous (the
        // attempt may have committed): the durable_commits row identifies
        // the applied batch and the commit adopts its seq.
        db.failTransactions = 1;
        const adopted = await storage.commit(writes, BACKGROUND_CONTEXT);
        expect(adopted).toBe(seq);
        const record = await storage.conversation(id as never, BACKGROUND_CONTEXT);
        expect((record as ConversationRecord | undefined)?.id).toBe(id);
      });
    },
    30_000,
  );

  it(
    "retries a commit through transient connection errors",
    async () => {
      await withStorage(async (storage, db) => {
        const id = await storage.mintId();
        db.failTransactions = 2;
        const seq = await storage.commit([conversationWrite(id)], BACKGROUND_CONTEXT);
        expect(seq).toBeGreaterThan(0);
        const record = await storage.conversation(id as never, BACKGROUND_CONTEXT);
        expect((record as ConversationRecord | undefined)?.id).toBe(id);
      });
    },
    30_000,
  );

  it(
    "retries a plain read through a transient connection error",
    async () => {
      database ??= await createDisposableDatabase();
      const pool = new pg.Pool({ connectionString: database.url, max: 2 });
      try {
        // The flake must sit BELOW the retry layer: PgPoolDatabase retries
        // transient query failures, so the failing connection is the pool
        // itself.
        const state: { failQueries: number } = { failQueries: 0 };
        const flaky = {
          query(sql: string, params?: unknown[]) {
            if (state.failQueries > 0) {
              state.failQueries--;
              throw Object.assign(new Error("Connection terminated unexpectedly"), { code: "ECONNRESET" });
            }
            return pool.query(sql, params as never[]);
          },
          connect: (...args: unknown[]) => (pool.connect as (...a: unknown[]) => unknown)(...args),
          end: () => pool.end(),
        } as unknown as pg.Pool;
        const db = new PgPoolDatabase(flaky);
        const storage = await PostgresDurableStorage.open(db);
        try {
          const id = await storage.mintId();
          await storage.commit([conversationWrite(id)], BACKGROUND_CONTEXT);
          state.failQueries = 1;
          const record = await storage.conversation(id as never, BACKGROUND_CONTEXT);
          expect((record as ConversationRecord | undefined)?.id).toBe(id);
        } finally {
          await storage.close(BACKGROUND_CONTEXT).catch(() => {});
        }
      } finally {
        await pool.end().catch(() => {});
      }
    },
    30_000,
  );

  it(
    "bounds a durable write transaction server-side and reports the bounds",
    async () => {
      await withStorage(async (storage) => {
        let inside: { statement: string; idle: string } | undefined;
        await (storage as unknown as { db: PostgresDatabase }).db.transaction(async (tx) => {
          const s = await tx.query<{ current_setting: string }>("SELECT current_setting('statement_timeout') AS current_setting");
          const i = await tx.query<{ current_setting: string }>(
            "SELECT current_setting('idle_in_transaction_session_timeout') AS current_setting",
          );
          inside = { statement: s[0]!.current_setting, idle: i[0]!.current_setting };
          return undefined;
        });
        expect(inside!.statement).toBe("30s");
        expect(inside!.idle).toBe("30s");
      });
    },
    30_000,
  );
});
