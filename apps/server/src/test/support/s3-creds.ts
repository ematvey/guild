// Host-service credentials for tests that talk to the shared host services.
// Secrets are host configuration and must never be committed: they are read
// from the environment, then from the gitignored test.env at the repo root.
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(process.cwd(), "../..");
const CONFIG_ENV_PATH = path.join(REPO_ROOT, "test.env");

function valueFromConfigEnv(key: string): string | undefined {
  try {
    const line = readFileSync(CONFIG_ENV_PATH, "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${key}=`));
    const value = line?.slice(key.length + 1).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** Access key id is a username, not a secret; `guild` is the dedicated test user. */
export function testS3AccessKeyId(envVar: string): string {
  return process.env[envVar] ?? "guild";
}

export function testS3SecretAccessKey(envVar: string): string {
  const fromEnv = process.env[envVar];
  if (fromEnv) return fromEnv;
  const fromConfig = valueFromConfigEnv("GUILD_S3_SECRET_ACCESS_KEY");
  if (fromConfig) return fromConfig;
  throw new Error(
    `${envVar} is not set and ${CONFIG_ENV_PATH} has no GUILD_S3_SECRET_ACCESS_KEY. ` +
      `Set the env var to run against the shared RustFS.`,
  );
}

/** ClickHouse credentials: the dev server requires the host user, so the
 *  skills runtime's table ensure succeeds instead of logging an auth error.
 *  Empty when neither the environment nor config.env provides them. */
export function testClickhouseUser(): string {
  return process.env.GUILD_CLICKHOUSE_USER ?? valueFromConfigEnv("GUILD_CLICKHOUSE_USER") ?? "";
}

export function testClickhousePassword(): string {
  return process.env.GUILD_CLICKHOUSE_PASSWORD ?? valueFromConfigEnv("GUILD_CLICKHOUSE_PASSWORD") ?? "";
}
