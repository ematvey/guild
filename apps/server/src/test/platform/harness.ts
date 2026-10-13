// M1 platform test harness: disposable Postgres database (verbatim Rust
// migrations applied in order) + disposable S3 bucket + a built app
// instance. Database name is namespaced `guild_m1_test_*` so the durable
// storage suite (guild_durable_test_*) can run concurrently.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";

// vitest runs with cwd = apps/server; the migrations live in the Rust tree
// (the historical record the TS schema ports verbatim).
const REPO_ROOT = path.resolve(process.cwd(), "../..");
export const MIGRATIONS_DIR = path.join(REPO_ROOT, "apps/server/migrations");

export const TEST_ADMIN_URL =
  process.env.GUILD_M1_TEST_DATABASE_URL ?? "postgres://guild:guild@localhost:5432/guild";
export const TEST_S3_URL = process.env.GUILD_M1_TEST_S3_URL ?? "http://localhost:9950";
export const TEST_S3_ACCESS_KEY_ID = process.env.GUILD_M1_TEST_S3_ACCESS_KEY_ID ?? "rustfsadmin";
export const TEST_S3_SECRET_ACCESS_KEY =
  process.env.GUILD_M1_TEST_S3_SECRET_ACCESS_KEY ?? "rustfsadmin";

function randomSuffix(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface M1TestEnv {
  databaseName: string;
  databaseUrl: string;
  bucketName: string;
  /** Pool on the DISPOSABLE database (seeding/preparation). */
  db: pg.Pool;
  app: Awaited<ReturnType<typeof buildApp>>;
  config: ReturnType<typeof loadConfig>;
  cleanup(): Promise<void>;
}

export async function createM1TestEnv(logLevel = "error"): Promise<M1TestEnv> {
  const suffix = randomSuffix();
  const databaseName = `guild_m1_test_${suffix}`;
  const bucketName = `guild-m1-test-${suffix}`;

  const adminPool = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 1, idleTimeoutMillis: 2000 });
  await adminPool.query(`CREATE DATABASE "${databaseName}"`);
  await adminPool.end();
  const databaseUrl = new URL(TEST_ADMIN_URL);
  databaseUrl.pathname = `/${databaseName}`;

  // Seeding/preparation pool on the disposable database — never on the
  // shared guild database the admin URL points at.
  const dbPool = new pg.Pool({ connectionString: databaseUrl.toString(), max: 2, idleTimeoutMillis: 2000 });

  // Apply the verbatim Rust migrations in order (plain SQL files).
  const migrationPool = new pg.Pool({ connectionString: databaseUrl.toString(), max: 2, idleTimeoutMillis: 2000 });
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    if (!file.endsWith(".sql")) continue;
    await migrationPool.query(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }
  await migrationPool.end();

  const s3 = new S3Client({
    endpoint: TEST_S3_URL,
    region: "us-east-1",
    forcePathStyle: true,
    credentials: { accessKeyId: TEST_S3_ACCESS_KEY_ID, secretAccessKey: TEST_S3_SECRET_ACCESS_KEY },
  });
  await s3.send(new CreateBucketCommand({ Bucket: bucketName }));

  const config = loadConfig({
    GUILD_DATABASE_URL: databaseUrl.toString(),
    GUILD_S3_URL: TEST_S3_URL,
    GUILD_S3_BUCKET: bucketName,
    GUILD_S3_ACCESS_KEY_ID: TEST_S3_ACCESS_KEY_ID,
    GUILD_S3_SECRET_ACCESS_KEY: TEST_S3_SECRET_ACCESS_KEY,
    GUILD_MASTER_KEY_HEX: "11".repeat(32),
    GUILD_JWT_SECRET: "m1-test-jwt-secret",
    GUILD_POOL_MAX: "5",
    GUILD_API_URL: "http://localhost:18080",
    GUILD_LOG_LEVEL: logLevel,
  });
  const app = await buildApp(config);

  let done = false;
  const cleanup = async (): Promise<void> => {
    if (done) return;
    done = true;
    await app.close();
    await dbPool.end();
    // Best-effort bucket wipe, then drop the database.
    try {
      const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucketName }));
      for (const obj of listed.Contents ?? []) {
        await s3.send(new DeleteObjectCommand({ Bucket: bucketName, Key: obj.Key! }));
      }
      await s3.send(new DeleteBucketCommand({ Bucket: bucketName }));
    } catch {
      // cleanup is best-effort; the DB drop below is the important part
    }
    s3.destroy();
    const dropper = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 1, idleTimeoutMillis: 2000 });
    try {
      // WITH (FORCE) can transiently fail ("permission denied to terminate
      // process") when a backend exits as the signal lands under load —
      // retry (the m2-harness cleanup does the same).
      for (let attempt = 1; ; attempt++) {
        try {
          await dropper.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
          break;
        } catch (error) {
          if (attempt >= 4) throw error;
          const message = error instanceof Error ? error.message : String(error);
          if (!message.includes("terminate process")) throw error;
          await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
        }
      }
    } finally {
      await dropper.end();
    }
  };

  return { databaseName, databaseUrl: databaseUrl.toString(), bucketName, db: dbPool, app, config, cleanup };
}
