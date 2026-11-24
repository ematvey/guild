// Platform test env: a disposable database with every migration applied
// (`guild_platform_test_*`), a disposable S3 bucket, and a built app.

import { createTestDatabase, testSuffix, TEST_ADMIN_URL } from "./postgres.js";
import path from "node:path";
import type pg from "pg";
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { testClickhousePassword, testClickhouseUser, testS3AccessKeyId, testS3SecretAccessKey } from "./s3-creds.js";

// vitest runs with cwd = apps/server.
const REPO_ROOT = path.resolve(process.cwd(), "../..");
export const MIGRATIONS_DIR = path.join(REPO_ROOT, "apps/server/migrations");

export { TEST_ADMIN_URL };
export const TEST_S3_URL = process.env.GUILD_TEST_S3_URL ?? "http://localhost:9950";
export const TEST_S3_ACCESS_KEY_ID = testS3AccessKeyId("GUILD_TEST_S3_ACCESS_KEY_ID");
export const TEST_S3_SECRET_ACCESS_KEY = testS3SecretAccessKey("GUILD_TEST_S3_SECRET_ACCESS_KEY");
export const TEST_CLICKHOUSE_USER = testClickhouseUser();
export const TEST_CLICKHOUSE_PASSWORD = testClickhousePassword();

export interface PlatformTestEnv {
  databaseName: string;
  databaseUrl: string;
  bucketName: string;
  /** Pool on the DISPOSABLE database (seeding/preparation). */
  db: pg.Pool;
  app: Awaited<ReturnType<typeof buildApp>>;
  config: ReturnType<typeof loadConfig>;
  cleanup(): Promise<void>;
}

export async function createPlatformTestEnv(logLevel = "error"): Promise<PlatformTestEnv> {
  const suffix = testSuffix();
  const database = await createTestDatabase("guild_platform_test_", { suffix, poolMax: 2 });
  const databaseName = database.name;
  const databaseUrl = new URL(database.url);
  const dbPool = database.pool;
  const bucketName = `guild-platform-test-${suffix}`;

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
    GUILD_JWT_SECRET: "platform-test-jwt-secret",
    GUILD_CLICKHOUSE_URL: process.env.GUILD_TEST_CLICKHOUSE_URL,
    GUILD_CLICKHOUSE_USER: TEST_CLICKHOUSE_USER,
    GUILD_CLICKHOUSE_PASSWORD: TEST_CLICKHOUSE_PASSWORD,
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
    await database.drop();
  };

  return { databaseName, databaseUrl: databaseUrl.toString(), bucketName, db: dbPool, app, config, cleanup };
}
