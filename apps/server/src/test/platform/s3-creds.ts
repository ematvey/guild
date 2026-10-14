// S3 credentials for tests that talk to the shared host RustFS (:9950).
// The secret key is host configuration and must never be committed: it is
// read from the environment, then from the gitignored
// deploy/compose/config.env, and the test fails fast if neither is present.
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(process.cwd(), "../..");
const CONFIG_ENV_PATH = path.join(REPO_ROOT, "deploy/compose/config.env");

function secretFromConfigEnv(): string | undefined {
  try {
    const line = readFileSync(CONFIG_ENV_PATH, "utf8")
      .split("\n")
      .find((l) => l.startsWith("GUILD_S3_SECRET_ACCESS_KEY="));
    const value = line?.slice("GUILD_S3_SECRET_ACCESS_KEY=".length).trim();
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
  const fromConfig = secretFromConfigEnv();
  if (fromConfig) return fromConfig;
  throw new Error(
    `${envVar} is not set and ${CONFIG_ENV_PATH} has no GUILD_S3_SECRET_ACCESS_KEY. ` +
      `Set the env var to run against the shared RustFS.`,
  );
}
