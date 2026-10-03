// Env-driven configuration, same style as the Rust server's config.env
// (deploy/compose/config.env.example, crates/server/src/config.rs). M1 adds
// the platform-core settings: Postgres, the secret master key, the OIDC
// state-signing secret, and S3 object storage.

export interface Config {
  /** Address the Fastify server binds, e.g. 0.0.0.0:8080 (GUILD_BIND_ADDR). */
  bindHost: string;
  bindPort: number;
  /** Base URL of the Rust server every non-native route proxies to
   *  (GUILD_UPSTREAM_URL, e.g. http://server-rust:8080). */
  upstreamUrl: string;
  /** pino log level (GUILD_LOG_LEVEL). */
  logLevel: string;
  /** Platform Postgres (GUILD_DATABASE_URL) — the same database the Rust
   *  server and the pi-durable storage use. */
  databaseUrl: string;
  /** 64 hex chars = 32-byte AES-256-GCM master key for stored secrets
   *  (GUILD_MASTER_KEY_HEX). */
  masterKeyHex: string;
  /** HS256 secret for the OIDC login-flow state token (GUILD_JWT_SECRET). */
  jwtSecret: string;
  /** S3-compatible object storage (GUILD_S3_URL, bucket, credentials). */
  s3Url: string;
  s3Bucket: string;
  s3AccessKeyId: string;
  s3SecretAccessKey: string;
  /** API base other components call back to (GUILD_API_URL) — shapes the
   *  OIDC redirect_uri and post-login app redirect. */
  apiUrl: string;
}

export const DEFAULT_BIND_ADDR = "0.0.0.0:8080";
export const DEFAULT_UPSTREAM_URL = "http://server-rust:8080";
export const DEFAULT_LOG_LEVEL = "info";
export const DEFAULT_DATABASE_URL = "postgres://guild:guild@localhost:5432/guild";
export const DEFAULT_S3_URL = "http://localhost:9000";
export const DEFAULT_S3_BUCKET = "guild";
export const DEFAULT_S3_ACCESS_KEY_ID = "minioadmin";
export const DEFAULT_S3_SECRET_ACCESS_KEY = "minioadmin";
export const DEFAULT_API_URL = "http://localhost:8080";

function parseBindAddr(addr: string): { host: string; port: number } {
  // Split at the last colon: works for 0.0.0.0:8080 and [::]:8080.
  const idx = addr.lastIndexOf(":");
  if (idx === -1) throw new Error(`GUILD_BIND_ADDR: missing port in "${addr}"`);
  const host = addr.slice(0, idx);
  const portStr = addr.slice(idx + 1);
  const port = Number(portStr);
  if (!host) throw new Error(`GUILD_BIND_ADDR: missing host in "${addr}"`);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`GUILD_BIND_ADDR: invalid port "${portStr}"`);
  }
  return { host, port };
}

function parseUpstreamUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`GUILD_UPSTREAM_URL: not a valid URL: "${raw}"`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`GUILD_UPSTREAM_URL: must be http(s), got "${url.protocol}"`);
  }
  // Normalize: no trailing slash, no path suffix — the proxy forwards the
  // full request path onto the upstream origin.
  return url.origin;
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
}

function parseMasterKey(raw: string): string {
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) {
    throw new Error("GUILD_MASTER_KEY_HEX must be 64 hex chars");
  }
  return raw.toLowerCase();
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const bind = parseBindAddr(env.GUILD_BIND_ADDR ?? DEFAULT_BIND_ADDR);
  const upstreamUrl = parseUpstreamUrl(env.GUILD_UPSTREAM_URL ?? DEFAULT_UPSTREAM_URL);
  const masterKeyHex = parseMasterKey(requireEnv(env, "GUILD_MASTER_KEY_HEX"));
  const jwtSecret = requireEnv(env, "GUILD_JWT_SECRET");
  const apiUrl = (env.GUILD_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
  return {
    bindHost: bind.host,
    bindPort: bind.port,
    upstreamUrl,
    logLevel: env.GUILD_LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    databaseUrl: env.GUILD_DATABASE_URL ?? DEFAULT_DATABASE_URL,
    masterKeyHex,
    jwtSecret,
    s3Url: env.GUILD_S3_URL ?? DEFAULT_S3_URL,
    s3Bucket: env.GUILD_S3_BUCKET ?? DEFAULT_S3_BUCKET,
    s3AccessKeyId: env.GUILD_S3_ACCESS_KEY_ID ?? DEFAULT_S3_ACCESS_KEY_ID,
    s3SecretAccessKey: env.GUILD_S3_SECRET_ACCESS_KEY ?? DEFAULT_S3_SECRET_ACCESS_KEY,
    apiUrl,
  };
}
