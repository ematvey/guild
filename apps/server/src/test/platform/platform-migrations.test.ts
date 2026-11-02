// Platform migrations (apps/server/migrations/*.sql) applied at startup:
// filename order, tracked in the schema_history table (name = file stem
// without .sql, applied_at, sha256 content_hash) — the same table the
// hand-run deployments use, so pre-existing rows are honored and
// re-application is a no-op. Failure is
// loud: a pending migration that throws aborts startup.

import { dropTestDatabase } from "../support/postgres.js";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyPlatformMigrations, readAmendments } from "../../platform/migrations.js";
import { execFileSync } from "node:child_process";
import { TEST_ADMIN_URL } from "../support/platform-env.js";

const REPO_ROOT = path.resolve(process.cwd(), "../..");
const REAL_MIGRATIONS_DIR = path.join(REPO_ROOT, "apps/server/migrations");

let admin: pg.Pool;
const databases: string[] = [];

beforeAll(() => {
  admin = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 1, idleTimeoutMillis: 2000 });
});

afterAll(async () => {
  for (const name of databases) {
    await dropTestDatabase(admin, name);
  }
  await admin.end();
}, 60_000);

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
    const expected = readdirSync(REAL_MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort()
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

  it("concurrent runners apply each file once", async () => {
    const { url } = await bareDatabase();
    // A second execution of the file would fail (the table already exists).
    const dir = tempMigrations({
      "0001_a.sql": "CREATE TABLE pm_race (id INT); SELECT pg_sleep(0.2)",
      "0002_b.sql": "CREATE TABLE pm_race_b (id INT)",
    });
    const pools = [0, 1, 2].map(() => new pg.Pool({ connectionString: url, max: 2 }));
    try {
      await Promise.all(pools.map((pool) => applyPlatformMigrations(pool, { dir })));
      expect((await history(url)).map((row) => row.name)).toEqual(["0001_a", "0002_b"]);
    } finally {
      await Promise.all(pools.map((pool) => pool.end()));
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
      await pool.query("INSERT INTO schema_history (name) VALUES ('0001_done')");
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
  it("an amendment listed in amended.json adopts the file's hash without a warning", async () => {
    const { url } = await bareDatabase();
    const original = "CREATE TABLE pm_t1 (id INT)";
    const dir = tempMigrations({ "0001_a.sql": original });
    try {
      const pool = new pg.Pool({ connectionString: url, max: 2 });
      await applyPlatformMigrations(pool, { dir });
      const amended = "-- reworded\nCREATE TABLE pm_t1 (id INT)";
      writeFileSync(path.join(dir, "0001_a.sql"), amended);
      writeFileSync(
        path.join(dir, "amended.json"),
        JSON.stringify({ "0001_a": { replaces: [sha256(original)], reason: "comment" } }),
      );
      const warns: unknown[] = [];
      const log = { warn: (entry: unknown) => warns.push(entry), info: () => {} } as never;
      await applyPlatformMigrations(pool, { dir, log });
      expect(warns).toEqual([]);
      expect((await history(url))[0]!.content_hash).toBe(sha256(amended));
      await pool.end();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A migration a released client's server shipped is never edited, unless
// amended.json lists the edit. The baseline is the newest client tag.
describe("shipped migrations", () => {
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let tag: string | null = null;
  try {
    tag = git("describe", "--tags", "--match", "client-v*", "--abbrev=0").trim();
  } catch {
    tag = null;
  }

  it.skipIf(tag === null)("are unchanged since the last client release, or listed as amended", () => {
    const amendments = readAmendments(REAL_MIGRATIONS_DIR);
    const shipped = git("ls-tree", "--name-only", `${tag}:apps/server/migrations`)
      .split("\n")
      .filter((name) => name.endsWith(".sql"));
    const edited: string[] = [];
    for (const file of shipped) {
      const before = sha256(git("show", `${tag}:apps/server/migrations/${file}`));
      const now = sha256(readFileSync(path.join(REAL_MIGRATIONS_DIR, file), "utf8"));
      const stem = file.replace(/\.sql$/, "");
      if (before !== now && amendments[stem]?.replaces.includes(before) !== true) edited.push(stem);
    }
    expect(edited).toEqual([]);
  });

  it("every amendment names a migration file", () => {
    const files = new Set(readdirSync(REAL_MIGRATIONS_DIR).map((file) => file.replace(/\.sql$/, "")));
    expect(Object.keys(readAmendments(REAL_MIGRATIONS_DIR)).filter((name) => !files.has(name))).toEqual([]);
  });
});
