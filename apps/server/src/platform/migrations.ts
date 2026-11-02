// Platform migrations (apps/server/migrations/*.sql): plain SQL files with
// zero-padded numeric prefixes, applied in filename order at server startup.
// The applied set is tracked in the schema_history table (name PRIMARY KEY,
// applied_at timestamptz DEFAULT now(), content_hash sha256 hex) — the same
// table and shape hand-run deployments use, with the file stem as the name
// ("0067_org_skills", no .sql), so rows recorded outside the server are
// honored and application is idempotent. Pending migrations run one
// transaction per file under a Postgres advisory lock, so concurrent
// starts apply each file once; any failure throws and aborts startup — a
// schema the server code does not match must never come up quietly.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Logger } from "pino";
import type { PlatformPool } from "./db.js";

export interface ApplyPlatformMigrationsOptions {
  /** Defaults to <cwd>/migrations (apps/server/migrations in the tree and
   *  in the server image, whose WORKDIR is /app/apps/server). */
  dir?: string;
  /** Warnings only — application failures always throw. */
  log?: Logger;
}

const MIGRATION_LOCK = "guild:platform-migrations";

export function platformMigrationsDir(): string {
  return path.resolve(process.cwd(), "migrations");
}

export async function applyPlatformMigrations(
  pool: PlatformPool,
  options: ApplyPlatformMigrationsOptions = {},
): Promise<void> {
  const dir = options.dir ?? platformMigrationsDir();
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort();
  } catch (error) {
    throw new Error(`platform migrations directory is unreadable: ${dir} (${(error as Error).message})`);
  }
  // One runner at a time: two servers starting together must not both see
  // a migration as pending. The session-level lock lives on this client and
  // the history is read only after it is held.
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext($1))", [MIGRATION_LOCK]);
    try {
      await client.query(`CREATE TABLE IF NOT EXISTS schema_history (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now(),
        content_hash text
      )`);
      const res = await client.query<{ name: string; content_hash: string | null }>(
        "SELECT name, content_hash FROM schema_history",
      );
      // The history convention (hand-run rows included) records the file
      // stem — "0067_org_skills", not "0067_org_skills.sql".
      const applied = new Map(res.rows.map((r) => [r.name, r.content_hash]));
      const stem = (file: string): string => file.replace(/\.sql$/, "");
      for (const file of files) {
        const bytes = readFileSync(path.join(dir, file));
        const hash = createHash("sha256").update(bytes).digest("hex");
        const known = applied.get(stem(file));
        if (known !== undefined) {
          if (known !== null && known !== hash) {
            options.log?.warn(
              { migration: stem(file), recorded_hash: known, current_hash: hash },
              "applied platform migration content drifted from schema_history",
            );
          }
          continue;
        }
        try {
          await client.query("BEGIN");
          await client.query(bytes.toString("utf8"));
          await client.query("INSERT INTO schema_history (name, content_hash) VALUES ($1, $2)", [stem(file), hash]);
          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK").catch(() => {});
          throw new Error(`platform migration ${stem(file)} failed: ${(error as Error).message}`);
        }
      }
    } finally {
      await client.query("SELECT pg_advisory_unlock(hashtext($1))", [MIGRATION_LOCK]).catch(() => {});
    }
  } finally {
    client.release();
  }
}

/** Workers verify the schema; only the server applies migrations. */
export async function assertPlatformSchema(pool: PlatformPool): Promise<void> {
  const latest = readdirSync(platformMigrationsDir())
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .at(-1)
    ?.replace(/\.sql$/, "");
  const result = await pool.query<{ present: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM schema_history WHERE name=$1) AS present",
    [latest],
  );
  if (!result.rows[0]?.present) throw new Error("platform schema requires server migration");
}
