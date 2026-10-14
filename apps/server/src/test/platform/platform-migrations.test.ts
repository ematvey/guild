// Platform migrations (apps/server/migrations/*.sql) applied at startup:
// filename order, tracked in the schema_history table (name = file stem
// without .sql, applied_at, sha256 content_hash) — the same table the
// hand-run deployments use, so pre-existing rows are honored and
// re-application is a no-op. Failure is
// loud: a pending migration that throws aborts startup.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPlatformMigrations } from "../../platform/migrations.js";
import { TEST_ADMIN_URL } from "./harness.js";

const REPO_ROOT = path.resolve(process.cwd(), "../..");
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "apps/server/migrations");

let admin: pg.Pool;
const databases: string[] = [];

beforeAll(() => {
  admin = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 1, idleTimeoutMillis: 2000 });
});

afterAll(async () => {
  for (const name of databases) {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
  }
  await admin.end();
});

async function bareDatabase(): Promise<{ name: string; url: string }> {
  const name = `guild_pm_test_${Math.random().toString(36).slice(2, 10)}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  databases.push(name);
  const url = new URL(TEST_ADMIN_URL);
  url.pathname = `/${name}`;
  return { name, url: url.toString() };
}

function tempMigrations(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "guild-pm-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(path.join(dir, name), content);
  return dir;
}

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

interface HistoryRow {
  name: string;
  applied_at: Date;
  content_hash: string | null;
}

async function history(url: string): Promise<HistoryRow[]> {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const res = await pool.query<HistoryRow>("SELECT name, applied_at, content_hash FROM schema_history ORDER BY name");
    return res.rows;
  } finally {
    await pool.end();
  }
}

describe("applyPlatformMigrations", () => {
  it("applies pending files in filename order and records name + sha256 in schema_history", async () => {
    const { url } = await bareDatabase();
    const first = "CREATE TABLE pm_t1 (id INT)";
    const second = "ALTER TABLE pm_t1 ADD COLUMN label TEXT";
    const dir = tempMigrations({ "0002_b.sql": second, "0001_a.sql": first });
    try {
      const pool = new pg.Pool({ connectionString: url, max: 2 });
      await applyPlatformMigrations(pool, { dir });
      const cols = await pool.query(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'pm_t1' ORDER BY column_name",
      );
      expect(cols.rows.map((r) => r.column_name)).toEqual(["id", "label"]); // order proves 0001 ran before 0002
      const rows = await history(url);
      expect(rows.map((r) => r.name)).toEqual(["0001_a", "0002_b"]); // stems, no .sql
      expect(rows[0]!.content_hash).toBe(sha256(first));
      expect(rows[1]!.content_hash).toBe(sha256(second));
      await pool.end();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the real migrations set applies cleanly to a bare database", async () => {
    const { url } = await bareDatabase();
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    await applyPlatformMigrations(pool, { dir: REAL_MIGRATIONS_DIR });
    const expected = readdirSync(REAL_MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()
      .map((f) => f.replace(/\.sql$/, "")); // history names are stems
    const rows = await history(url);
    expect(rows.map((r) => r.name)).toEqual(expected);
    for (const row of rows) {
      expect(row.content_hash).toBe(sha256(readFileSync(path.join(REAL_MIGRATIONS_DIR, `${row.name!}.sql`), "utf8")));
    }
    // The newest schema additions are present (0067's org-skills tables).
    const tables = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('chats', 'registry_items', 'skill_installs')",
    );
    expect(tables.rows.map((r) => r.table_name).sort()).toEqual(["chats", "registry_items", "skill_installs"]);
    await pool.end();
  });

  it("a second run is a no-op: rows keep their applied_at, files are not re-executed", async () => {
    const { url } = await bareDatabase();
    // Re-running would fail if the file executed again (table already exists).
    const dir = tempMigrations({ "0001_a.sql": "CREATE TABLE pm_t1 (id INT)" });
    try {
      const pool = new pg.Pool({ connectionString: url, max: 2 });
      await applyPlatformMigrations(pool, { dir });
      const before = await history(url);
      await applyPlatformMigrations(pool, { dir });
      const after = await history(url);
      expect(after).toEqual(before);
      await pool.end();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("honors pre-existing schema_history rows (hand-run deployments, hash optional)", async () => {
    const { url } = await bareDatabase();
    // The file must not execute — the row says it was already applied.
    const dir = tempMigrations({ "0001_done.sql": "SELECT 1 / 0" });
    try {
      const pool = new pg.Pool({ connectionString: url, max: 2 });
      // The table pre-exists on hand-run deployments (exact live shape).
      await pool.query(
        "CREATE TABLE schema_history (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), content_hash text)",
      );
      await pool.query(
        "INSERT INTO schema_history (name) VALUES ('0001_done')",
      );
      await expect(applyPlatformMigrations(pool, { dir })).resolves.toBeUndefined();
      await pool.end();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("content drift on an applied file warns but does not throw or re-apply", async () => {
    const { url } = await bareDatabase();
    const dir = tempMigrations({ "0001_a.sql": "CREATE TABLE pm_t1 (id INT)" });
    try {
      const pool = new pg.Pool({ connectionString: url, max: 2 });
      await applyPlatformMigrations(pool, { dir });
      await pool.query("UPDATE schema_history SET content_hash = 'stale'");
      const warns: unknown[] = [];
      await applyPlatformMigrations(pool, { dir, log: { warn: (entry: unknown) => warns.push(entry) } as never });
      expect(warns).toHaveLength(1);
      const rows = await history(url);
      expect(rows).toHaveLength(1);
      await pool.end();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a failing migration aborts loudly and records nothing", async () => {
    const { url } = await bareDatabase();
    const dir = tempMigrations({
      "0001_ok.sql": "CREATE TABLE pm_t1 (id INT)",
      "0002_broken.sql": "CREATE TABLE pm_broken (",
    });
    try {
      const pool = new pg.Pool({ connectionString: url, max: 2 });
      await expect(applyPlatformMigrations(pool, { dir })).rejects.toThrow(/0002_broken\b/);
      const rows = await history(url);
      expect(rows.map((r) => r.name)).toEqual(["0001_ok"]); // stem recorded, no .sql
      await pool.end();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
