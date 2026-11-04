// Provision only the fixed, disposable Agents VFS resources.
//
// Usage: node scripts/agents-vfs-init.mjs [config.env]
//
// The isolated compose project (guild-agents-vfs, :18093) uses its own
// config file. The script refuses any other database, bucket, port, or
// volume directory, so a dev/prod config can never be provisioned by it.
import { mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import pg from "pg";
import { S3Client, CreateBucketCommand, HeadBucketCommand } from "@aws-sdk/client-s3";

const PROJECT = "guild-agents-vfs";
const PORT = "18093";
const DATABASE = "guild_agents_vfs";
const META_DATABASE = "guild_meta_agents_vfs";
const BUCKET = "guild-agents-vfs";
const HOST_DIR = "/mnt/guild-agents-vfs";
const JUICE_VOLUME = "guild-workspaces-agents-vfs";
const WORKSPACES_VOLUME = `${PROJECT}_guild_workspaces`;

const configPath = resolve(process.argv[2] ?? fileURLToPath(new URL("../deploy/compose/config.env", import.meta.url)));
const config = Object.fromEntries(
  readFileSync(configPath, "utf8")
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const at = line.indexOf("=");
      return [line.slice(0, at), line.slice(at + 1)];
    }),
);

const problems = [];
if (!config.GUILD_DATABASE_URL) {
  problems.push("GUILD_DATABASE_URL is required");
}
const database = new URL(config.GUILD_DATABASE_URL ?? "postgres://invalid/invalid");
if (config.GUILD_DATABASE_URL && database.pathname !== `/${DATABASE}`) {
  problems.push(`GUILD_DATABASE_URL must name the database ${DATABASE}`);
}
if (!config.GUILD_S3_URL || !config.GUILD_S3_ACCESS_KEY_ID || !config.GUILD_S3_SECRET_ACCESS_KEY) {
  problems.push("GUILD_S3_URL, GUILD_S3_ACCESS_KEY_ID and GUILD_S3_SECRET_ACCESS_KEY are required");
}
if ((config.GUILD_HTTP_PORT ?? "8080") !== PORT) {
  problems.push(`GUILD_HTTP_PORT must be ${PORT}`);
}
if ((config.GUILD_S3_BUCKET ?? "guild") !== BUCKET) {
  problems.push(`GUILD_S3_BUCKET must be ${BUCKET}`);
}
// The JuiceFS filesystem is named by the compose environment (printed below),
// not config.env; a config that still sets these must agree with it.
if ((config.GUILD_WORKSPACE_HOST_DIR ?? HOST_DIR) !== HOST_DIR) {
  problems.push(`GUILD_WORKSPACE_HOST_DIR must be ${HOST_DIR}`);
}
if ((config.GUILD_JUICE_META_DB ?? META_DATABASE) !== META_DATABASE) {
  problems.push(`GUILD_JUICE_META_DB must be ${META_DATABASE}`);
}
if (config.GUILD_JUICE_META_URL) {
  const meta = new URL(config.GUILD_JUICE_META_URL);
  if (meta.pathname !== `/${META_DATABASE}`) {
    problems.push(`GUILD_JUICE_META_URL must name the database ${META_DATABASE}`);
  }
}
if (config.GUILD_COMPOSE_PROJECT && config.GUILD_COMPOSE_PROJECT !== PROJECT) {
  problems.push(`GUILD_COMPOSE_PROJECT must be ${PROJECT}`);
}
if (problems.length > 0) {
  throw new Error(
    `refusing to provision outside the isolated Agents VFS resources (${configPath}):\n  ${problems.join("\n  ")}`,
  );
}

database.hostname = database.hostname.replace("host.docker.internal", "127.0.0.1");
const admin = new URL(database.toString());
admin.pathname = "/postgres";

try {
  mkdirSync(HOST_DIR, { recursive: true });
} catch (error) {
  throw new Error(`cannot create ${HOST_DIR}: ${error.message} (run: sudo mkdir -p ${HOST_DIR})`);
}

const pool = new pg.Pool({ connectionString: admin.toString(), max: 1 });

async function ensureDatabase(name) {
  const found = await pool.query("SELECT 1 FROM pg_database WHERE datname=$1", [name]);
  if (found.rows.length === 0) await pool.query(`CREATE DATABASE "${name}"`);
}

try {
  await ensureDatabase(DATABASE);
  await ensureDatabase(META_DATABASE);
} finally {
  await pool.end();
}

const s3 = new S3Client({
  endpoint: config.GUILD_S3_URL.replace("host.docker.internal", "127.0.0.1"),
  region: "us-east-1",
  forcePathStyle: true,
  credentials: {
    accessKeyId: config.GUILD_S3_ACCESS_KEY_ID,
    secretAccessKey: config.GUILD_S3_SECRET_ACCESS_KEY,
  },
});
try {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  } catch (error) {
    if (error.$metadata?.httpStatusCode !== 404) throw error;
    await s3.send(new CreateBucketCommand({ Bucket: BUCKET }));
  }
} finally {
  s3.destroy();
}

console.log(`Isolated Agents VFS resources are ready in ${configPath}:`);
console.log(`  project ${PROJECT}, port ${PORT}`);
console.log(`  Postgres ${DATABASE}, JuiceFS metadata ${META_DATABASE}`);
console.log(`  S3 ${BUCKET}, host volume dir ${HOST_DIR}`);
console.log("");
console.log("Bring the stack up with:");
console.log(
  `  GUILD_CONFIG_ENV=${configPath} GUILD_WORKSPACE_HOST_DIR=${HOST_DIR} GUILD_JUICE_META_DB=${META_DATABASE} ` +
    `GUILD_JUICE_VOLUME=${JUICE_VOLUME} GUILD_JUICE_BUCKET=${BUCKET} GUILD_WORKSPACES_VOLUME=${WORKSPACES_VOLUME} ` +
    `docker compose -p ${PROJECT} -f deploy/compose/docker-compose.yml up -d`,
);
