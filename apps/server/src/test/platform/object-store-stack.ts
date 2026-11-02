// A disposable stack with object storage: a fresh Postgres database with
// every migration applied (`guild_<prefix>_test_*`), a fresh rustfs bucket,
// and the app built against both.

import { dropTestDatabase } from "../support/postgres.js";
import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import * as tar from "tar";
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
import { applyPlatformMigrations } from "../../platform/migrations.js";
import { testClickhousePassword, testClickhouseUser, testS3AccessKeyId, testS3SecretAccessKey } from "./s3-creds.js";

const TEST_ADMIN_URL = process.env.GUILD_TEST_PG_URL ?? "postgres://guild:guild@localhost:5432/guild";
const TEST_S3_URL = process.env.GUILD_TEST_S3_URL ?? "http://localhost:9950";
const TEST_S3_ACCESS_KEY_ID = testS3AccessKeyId("GUILD_TEST_S3_ACCESS_KEY_ID");
const TEST_S3_SECRET_ACCESS_KEY = testS3SecretAccessKey("GUILD_TEST_S3_SECRET_ACCESS_KEY");
const TEST_CLICKHOUSE_USER = testClickhouseUser();
const TEST_CLICKHOUSE_PASSWORD = testClickhousePassword();

function randomSuffix(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface ObjectStoreStack {
  databaseName: string;
  databaseUrl: string;
  bucketName: string;
  /** Pool on the DISPOSABLE database (seeding/preparation). */
  db: pg.Pool;
  app: Awaited<ReturnType<typeof buildApp>>;
  config: ReturnType<typeof loadConfig>;
  cleanup(): Promise<void>;
}

export async function createObjectStoreStack(
  logLevel = "error",
  extraEnv: Record<string, string> = {},
  prefix = "stack",
): Promise<ObjectStoreStack> {
  const suffix = randomSuffix();
  const databaseName = `guild_${prefix.replaceAll("-", "_")}_test_${suffix}`;
  const bucketName = `guild-${prefix.replaceAll("_", "-")}-test-${suffix}`;

  const adminPool = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 1 });
  await adminPool.query(`CREATE DATABASE "${databaseName}"`);
  const databaseUrl = new URL(TEST_ADMIN_URL);
  databaseUrl.pathname = `/${databaseName}`;

  // Seeding/preparation pool on the disposable database — never on the
  // shared guild database the admin URL points at.
  const dbPool = new pg.Pool({ connectionString: databaseUrl.toString(), max: 2 });

  const migrationPool = new pg.Pool({ connectionString: databaseUrl.toString(), max: 2 });
  // The production startup path (applyPlatformMigrations): same filename
  // order, same schema_history tracking hand-run deployments use.
  await applyPlatformMigrations(migrationPool);
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
    GUILD_MASTER_KEY_HEX: "22".repeat(32),
    GUILD_JWT_SECRET: `${prefix}-test-jwt-secret`,
    GUILD_CLICKHOUSE_USER: TEST_CLICKHOUSE_USER,
    GUILD_CLICKHOUSE_PASSWORD: TEST_CLICKHOUSE_PASSWORD,
    GUILD_API_URL: "http://localhost:18080",
    GUILD_LOG_LEVEL: logLevel,
    ...extraEnv,
  });
  const app = await buildApp(config);

  let done = false;
  const cleanup = async (): Promise<void> => {
    if (done) return;
    done = true;
    await app.close();
    await dbPool.end();
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
    const dropper = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 1 });
    try {
      await dropTestDatabase(dropper, databaseName);
    } finally {
      await dropper.end();
    }
    await adminPool.end();
  };

  return { databaseName, databaseUrl: databaseUrl.toString(), bucketName, db: dbPool, app, config, cleanup };
}

/** In-memory-shaped tar.gz pack for registry bundles — the shape the
 *  client's pack() produces: manifest.json at the root, then arbitrary
 *  files. Packed via tar's sync file API into a temp dir. */
export async function packBundle(files: Record<string, Buffer | string>): Promise<Buffer> {
  const dir = mkdtempSync(path.join(tmpdir(), "bundle-pack-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      const filePath = path.join(dir, name);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
    }
    const tgz = path.join(dir, "bundle.tar.gz");
    tar.c({ sync: true, gzip: true, cwd: dir, file: tgz, portable: true }, Object.keys(files));
    return readFileSync(tgz);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
