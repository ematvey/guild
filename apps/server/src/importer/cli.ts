#!/usr/bin/env node
// `npm run import-threads` — the re-runnable thread importer CLI.
//
// Reads GUILD_DATABASE_URL (or --database) and GUILD_S3_* from the
// environment, truncates + rebuilds the durable_* tables and the
// chat_conversations mapping from `thread_events`. Stop the TS server while
// the importer owns the store.

import pg from "pg";
import { loadConfig } from "../config.js";
import { ObjectStore } from "../platform/s3.js";
import { importThreads } from "./importer.js";

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const config = loadConfig(process.env);
const databaseUrl = argValue("--database") ?? process.env.GUILD_DATABASE_URL ?? process.env.DATABASE_URL;
if (databaseUrl === undefined || databaseUrl === "") {
  console.error("import-threads: set GUILD_DATABASE_URL (or pass --database postgres://...)");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });

const objects =
  config.s3Url !== "" && config.s3AccessKeyId !== "" && config.s3SecretAccessKey !== ""
    ? new ObjectStore(config)
    : undefined;
if (objects === undefined) {
  console.warn("import-threads: object storage not configured — image parts are not replayed into user entries");
}

// Route image support: a direct modalities lookup (the importer needs no
// provider keys).
async function supportsImages(orgId: string, model: string): Promise<boolean> {
  const res = await pool.query<{ modalities: string[] | null }>(
    "SELECT modalities FROM model_routes WHERE org_id = $1 AND model = $2",
    [orgId, model],
  );
  return (res.rows[0]?.modalities ?? []).includes("image");
}

try {
  const counts = await importThreads(
    pool as unknown as Parameters<typeof importThreads>[0],
    { info: (m) => console.log(m), warn: (m) => console.warn(m) },
    { objects, supportsImages },
  );
  console.log(
    `chats=${counts.chats} conversations=${counts.conversations} events=${counts.events} entries=${counts.entries} emptyChats=${counts.emptyChats}`,
  );
} catch (error) {
  console.error("import-threads failed:", error);
  process.exitCode = 1;
} finally {
  await pool.end();
}
