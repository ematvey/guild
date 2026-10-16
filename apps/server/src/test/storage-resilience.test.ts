// Durable storage resilience: the fail-stop session means one storage error
// seals every conversation in the process, so the Postgres adapter must
// absorb transient connection failures (retry) and ambiguous commit
// outcomes (adoption through the durable_commits row) before they reach
// the session guard.

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai";
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
  loseCommitReply = false;

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
    const result = await this.inner.transaction(callback);
    if (this.loseCommitReply) {
      this.loseCommitReply = false;
      throw Object.assign(new Error("connection reset after COMMIT"), { code: "ECONNRESET" });
    }
    return result;
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
        db.loseCommitReply = true;
        const seq = await storage.commit(writes, BACKGROUND_CONTEXT);
        expect(seq).toBeGreaterThan(0);
        await expect(storage.commit(writes, BACKGROUND_CONTEXT)).rejects.toThrow("already belongs to conversation");
        db.failTransactions = 1;
        await expect(storage.commit(writes, BACKGROUND_CONTEXT)).rejects.toThrow("already belongs to conversation");
        const record = await storage.conversation(id as never, BACKGROUND_CONTEXT);
        expect((record as ConversationRecord | undefined)?.id).toBe(id);
      });
    },
    30_000,
  );

  it("does not adopt an older checkpoint touching the same task", async () => {
    await withStorage(async (storage, db) => {
      const conversationId = await storage.mintId();
      await storage.commit([conversationWrite(conversationId)], BACKGROUND_CONTEXT);
      const id = await storage.mintId();
      const task = { id, conversationId, kind: "test.checkpoint", version: 1, input: {}, background: false, abortRequested: false,
        state: { status: "pending", checkpoint: { n: 1 } } };
      const first = await storage.commit([{ type: "task", value: task }] as never, BACKGROUND_CONTEXT);
      db.failTransactions = 1;
      const second = await storage.commit([{ type: "task", value: { ...task, state: { status: "pending", checkpoint: { n: 2 } } } }] as never, BACKGROUND_CONTEXT);
      expect(second).toBeGreaterThan(first);
      expect((await storage.task(id as never, BACKGROUND_CONTEXT))?.state).toMatchObject({ checkpoint: { n: 2 } });
      db.loseCommitReply = true;
      await storage.commit([{ type: "task", value: { ...task, state: { status: "pending", checkpoint: { n: 3 } } } }] as never, BACKGROUND_CONTEXT);
      expect((await storage.task(id as never, BACKGROUND_CONTEXT))?.state).toMatchObject({ checkpoint: { n: 3 } });
    });
  });

  it("stores distinct document-only deltas through ambiguous and pre-commit failures", async () => {
    await withStorage(async(storage,db)=>{
      const Counter=defineDoc({kind:"test.counter",version:1,scope:"conversation",history:"latest",fork:"initial",initial:()=>({n:0})});
      const h=await Harness.open(storage,{models:createModels(),registry:createRegistry()},BACKGROUND_CONTEXT);
      try {
        const c=await h.root(BACKGROUND_CONTEXT);
        const set=async(n:number)=>c.commit(async tx=>{(await tx.doc(Counter,c.id)).n=n;},BACKGROUND_CONTEXT);
        await set(1);db.failTransactions=1;await set(2);
        expect(await h.snapshot(Counter,c.id,BACKGROUND_CONTEXT)).toEqual({n:2});
        db.loseCommitReply=true;await set(3);
        expect(await h.snapshot(Counter,c.id,BACKGROUND_CONTEXT)).toEqual({n:3});
      }finally{await h.close(BACKGROUND_CONTEXT);}
    });
  });

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
