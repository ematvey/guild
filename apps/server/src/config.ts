// Env-driven configuration, same style as the Rust server's config.env
//. M1 adds
// the platform-core settings: Postgres, the secret master key, the OIDC
// state-signing secret, and S3 object storage.

import path from "node:path";

export interface Config {
  /** Address the Fastify server binds, e.g. 0.0.0.0:8080 (GUILD_BIND_ADDR). */
  bindHost: string;
  bindPort: number;
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
  /** ClickHouse HTTP interface (GUILD_CLICKHOUSE_URL/DATABASE/USER/PASSWORD)
   *  — usage_events sink and usage/quota queries. Empty user = no auth. */
  clickhouseUrl: string;
  clickhouseDatabase: string;
  clickhouseUser: string;
  clickhousePassword: string;
  /** Static internal API key accepted by the gateway auth path (both LLM
   *  endpoint shapes). Never issued or returned by the public API; the
   *  pi-durable harness (M3) calls /openai/v1 over loopback with it.
   *  Internal calls are org-scoped via the x-guild-org-id request header
   *  and metered like external clients (platform/usage.ts). */
  internalKey: string | null;
  /** Base URL this process reaches ITSELF at (GUILD_SELF_BASE_URL, default
   *  http://127.0.0.1:<bindPort>) — the model provider's loopback target
   *  (spec decision 7). */
  selfBaseUrl: string;
  /** Upstream Faro receiver for browser telemetry proxying (/faro/collect)
   *  (GUILD_FARO_URL). Empty disables the endpoint. */
  faroUrl: string;
  /** Directory the web UI bundle is served from (GUILD_WEB_DIST; default
   *  apps/desktop/dist next to the server package). Null = no dist
   *  directory configured — pages answer with the 503 hint. */
  webDistDir: string | null;
  /** Platform Postgres pool cap (GUILD_POOL_MAX, default 10). Test
   *  harnesses set it lower so the shared dev server's connection budget
   *  fits several suites. */
  poolMax: number;
  /** Server-side data dir (GUILD_DATA_DIR, default ./data): the workspace
   *  session root (workspaces/<org>/<name>) lives under it. */
  dataDir: string;
  /** Whether server-side executors may run shell tools at all
   *  (GUILD_ALLOW_SHELL_TOOLS; default on with a sandbox runner, off
   *  otherwise — machine `execute` calls ride the exec policy instead). */
  allowShellTools: boolean;
  /** Where server-side tools run (GUILD_SANDBOX): `runner` — gVisor
   *  sandboxes via the sandbox runner; `inprocess-unsafe` — in the server
   *  process, unconfined (tests/dev only, refused in production);
   *  `disabled` — server-side tools fail. Default: runner when
   *  GUILD_SANDBOX_RUNNER_URL is set, else disabled in production and
   *  inprocess-unsafe elsewhere. */
  sandbox: SandboxConfig;
  /** Approval card deadline (GUILD_APPROVAL_TIMEOUT_MS, default 5 min — the
   *  Rust APPROVAL_TIMEOUT); the gate auto-denies when it lapses. */
  approvalTimeoutMs: number;
  /** Machine-tool dispatch deadline (GUILD_CLIENT_TOOL_TIMEOUT_MS, default
   *  5 min — the Rust CLIENT_TOOL_TIMEOUT). */
  clientToolTimeoutMs: number;
  /** Exec-policy base rules file (GUILD_EXEC_POLICY_RULES). Default: the
   *  Rust tree's static asset. */
  execPolicyRulesPath: string | null;
  /** LLM trace payload capture (GUILD_TRACE_PAYLOADS=1, default off): the
   *  llm_payloads request/response bodies are a deliberate choice — the
   *  metadata table (llm_calls) is always on. */
  tracePayloads: boolean;
}

export type SandboxConfig =
  | { mode: "runner"; runnerUrl: string; runnerToken: string }
  | { mode: "inprocess-unsafe" }
  | { mode: "disabled" };

export function parseSandboxConfig(env: NodeJS.ProcessEnv): SandboxConfig {
  const runnerUrl = env.GUILD_SANDBOX_RUNNER_URL;
  const production = env.NODE_ENV === "production";
  const mode = env.GUILD_SANDBOX ?? (runnerUrl ? "runner" : production ? "disabled" : "inprocess-unsafe");
  if (mode === "runner") {
    if (!runnerUrl) throw new Error("GUILD_SANDBOX=runner requires GUILD_SANDBOX_RUNNER_URL");
    const runnerToken = env.GUILD_SANDBOX_RUNNER_TOKEN ?? "";
    if (runnerToken.length < 16) throw new Error("GUILD_SANDBOX_RUNNER_TOKEN must be set (16+ chars)");
    return { mode, runnerUrl: parseUrl(runnerUrl, "GUILD_SANDBOX_RUNNER_URL").replace(/\/+$/, ""), runnerToken };
  }
  if (mode === "inprocess-unsafe") {
    if (production) throw new Error("GUILD_SANDBOX=inprocess-unsafe is refused when NODE_ENV=production");
    return { mode };
  }
  if (mode === "disabled") return { mode };
  throw new Error(`GUILD_SANDBOX must be runner, inprocess-unsafe or disabled (got ${mode})`);
}

export const DEFAULT_BIND_ADDR = "0.0.0.0:8080";
export const DEFAULT_LOG_LEVEL = "info";
export const DEFAULT_DATABASE_URL = "postgres://guild:guild@localhost:5432/guild";
export const DEFAULT_S3_URL = "http://localhost:9000";
export const DEFAULT_S3_BUCKET = "guild";
export const DEFAULT_S3_ACCESS_KEY_ID = "minioadmin";
export const DEFAULT_S3_SECRET_ACCESS_KEY = "minioadmin";
export const DEFAULT_API_URL = "http://localhost:8080";
export const DEFAULT_CLICKHOUSE_URL = "http://localhost:8123";
export const DEFAULT_CLICKHOUSE_DATABASE = "guild";
export const DEFAULT_FARO_URL = "http://host.docker.internal:12347/collect";

/** The web UI dist directory the server serves the SPA from. Conventional
 *  default: apps/desktop/dist, one level up from apps/server. */
export function defaultWebDistDir(): string | null {
  return path.resolve(process.cwd(), "../desktop/dist");
}

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

function parseUrl(raw: string, label: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`must be http(s), got "${url.protocol}"`);
    }
    return url.origin;
  } catch (error) {
    throw new Error(`${label}: not a valid URL: "${raw}"`);
  }
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
  const clickhouseUrl = parseUrl(env.GUILD_CLICKHOUSE_URL ?? DEFAULT_CLICKHOUSE_URL, "GUILD_CLICKHOUSE_URL");
  const masterKeyHex = parseMasterKey(requireEnv(env, "GUILD_MASTER_KEY_HEX"));
  const jwtSecret = requireEnv(env, "GUILD_JWT_SECRET");
  const apiUrl = (env.GUILD_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const internalKey = env.GUILD_INTERNAL_KEY ?? null;
  const selfBaseUrl = parseUrl(env.GUILD_SELF_BASE_URL ?? `http://127.0.0.1:${bind.port}`, "GUILD_SELF_BASE_URL");
  const faroUrl = env.GUILD_FARO_URL ?? DEFAULT_FARO_URL;
  const webDistDir = env.GUILD_WEB_DIST === undefined || env.GUILD_WEB_DIST === ""
    ? defaultWebDistDir()
    : env.GUILD_WEB_DIST;
  const sandbox = parseSandboxConfig(env);
  const allowShellTools = env.GUILD_ALLOW_SHELL_TOOLS === undefined || env.GUILD_ALLOW_SHELL_TOOLS === ""
    ? sandbox.mode === "runner"
    : env.GUILD_ALLOW_SHELL_TOOLS === "1";
  const approvalTimeoutMs = Number(env.GUILD_APPROVAL_TIMEOUT_MS ?? 300_000);
  const clientToolTimeoutMs = Number(env.GUILD_CLIENT_TOOL_TIMEOUT_MS ?? 300_000);
  // Absolute: the workspace root and sandbox root must not depend on the
  // server process's cwd (pi-durable re-resolves tool cwds against it).
  const poolMax = Number(env.GUILD_POOL_MAX ?? 10);
  const dataDir = path.resolve(env.GUILD_DATA_DIR ?? "./data");
  const tracePayloads = env.GUILD_TRACE_PAYLOADS === "1";
  return {
    faroUrl,
    webDistDir,
    internalKey,
    selfBaseUrl,
    clickhouseUrl,
    clickhouseDatabase: env.GUILD_CLICKHOUSE_DATABASE ?? DEFAULT_CLICKHOUSE_DATABASE,
    clickhouseUser: env.GUILD_CLICKHOUSE_USER ?? "",
    clickhousePassword: env.GUILD_CLICKHOUSE_PASSWORD ?? "",
    bindHost: bind.host,
    bindPort: bind.port,
    logLevel: env.GUILD_LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
    databaseUrl: env.GUILD_DATABASE_URL ?? DEFAULT_DATABASE_URL,
    masterKeyHex,
    jwtSecret,
    s3Url: env.GUILD_S3_URL ?? DEFAULT_S3_URL,
    s3Bucket: env.GUILD_S3_BUCKET ?? DEFAULT_S3_BUCKET,
    s3AccessKeyId: env.GUILD_S3_ACCESS_KEY_ID ?? DEFAULT_S3_ACCESS_KEY_ID,
    s3SecretAccessKey: env.GUILD_S3_SECRET_ACCESS_KEY ?? DEFAULT_S3_SECRET_ACCESS_KEY,
    apiUrl,
    poolMax,
    dataDir,
    allowShellTools,
    sandbox,
    approvalTimeoutMs,
    clientToolTimeoutMs,
    execPolicyRulesPath: env.GUILD_EXEC_POLICY_RULES ?? null,
    tracePayloads,
  };
}
