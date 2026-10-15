// TEMP scratch: reproduce the 0070 "already exists" failure on a fresh DB.
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { applyPlatformMigrations } from "../platform/migrations.js";
import { TEST_ADMIN_URL } from "./platform/harness.js";

const dbName = `guild_scratch_${Math.random().toString(16).slice(2, 10)}`;

describe("scratch", () => {
  let pool: pg.Pool;
  it("applies cleanly to a fresh database", async () => {
    const admin = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 1 });
    await admin.query(`CREATE DATABASE "${dbName}"`);
    await admin.end();
    const url = TEST_ADMIN_URL.replace(/\/[^/]*$/, `/${dbName}`);
    pool = new pg.Pool({ connectionString: url, max: 2 });
    await applyPlatformMigrations(pool);
    const hist = await pool.query("SELECT name FROM schema_history WHERE name LIKE '007%'");
    console.log("history 007x:", hist.rows.map((r) => r.name));
    const idx = await pool.query("SELECT indexname FROM pg_indexes WHERE indexname='thread_events_chat_seq_idx'");
    console.log("index:", idx.rows.map((r) => r.indexname));
    expect(hist.rows.map((r) => r.name)).toContain("0070_thread_events_chat_seq_idx");
  }, 60_000);

  afterAll(async () => {
    if (pool) await pool.end();
    const admin = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 1 });
    await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin.end();
  });
});
