// Env-driven configuration (GUILD_* variables; the compose stack reads them
// from config.env): bind address, Postgres, ClickHouse, S3, secrets, the
// sandbox runner, and the runtime tunables.

import path from "node:path";
import { createRequire } from "node:module";

const serverManifest = createRequire(import.meta.url)("../package.json");
export const GUILD_TS_SERVER_VERSION: string = serverManifest.version;

export interface Config {
  /** Version baked into this server image, including temporary develop stamps. */
  serverVersion: string;
  serverCommit?: string;
  /** Address the Fastify server binds, e.g. 0.0.0.0:8080 (GUILD_BIND_ADDR). */
  bindHost: string;
  bindPort: number;
  /** pino log level (GUILD_LOG_LEVEL). */
  logLevel: string;
  /** Platform Postgres (GUILD_DATABASE_URL) — the same database the
   *  pi-durable storage uses. */
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
  /** Public GitHub repository that supplies signed desktop releases. */
  releaseRepository: string | null;
  /** ClickHouse HTTP interface (GUILD_CLICKHOUSE_URL/DATABASE/USER/PASSWORD)
   *  — usage_events sink and usage/quota queries. Empty user = no auth. */
  clickhouseUrl: string;
  clickhouseDatabase: string;
  clickhouseUser: string;
  clickhousePassword: string;
  /** Static internal API key accepted by the gateway auth path (both LLM
   *  endpoint shapes). Never issued or returned by the public API; the
   *  pi-durable harness calls /openai/v1 over loopback with it.
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
  controlDistDir: string | null;
  /** Platform Postgres pool cap (GUILD_POOL_MAX, default 10). Test
   *  harnesses set it lower so the shared dev server's connection budget
   *  fits several suites. */
  poolMax: number;
  /** Server-side data dir (GUILD_DATA_DIR, default ./data): the workspace
   *  session root (workspaces/<org>/<name>) lives under it. */
  dataDir: string;
  /** Root of the agent workspace volume as the server sees it
   *  (GUILD_AGENT_WORKSPACE_ROOT, default /workspaces): agent subpaths
   *  resolve under it for the file browser. */
  agentWorkspaceRoot: string;
  /** The same workspace volume mounted read-write, used only for delegation
   *  artifact transfer (the file browser and runtime reads stay read-only). */
  agentWorkspaceWriteRoot: string;
  /** Whether server-side executors may run shell tools at all
   *  (GUILD_ALLOW_SHELL_TOOLS; default on with a sandbox runner, off
   *  otherwise — machine `execute` calls ride the exec policy instead). */
  allowShellTools: boolean;
  /** Where server-side tools run (GUILD_SANDBOX): `runner` — gVisor
   *  sandboxes via the sandbox runner; `inprocess-unsafe` — in the server
   *  process, unconfined (tests/dev only, refused in production). Default:
   *  runner when GUILD_SANDBOX_RUNNER_URL is set, else inprocess-unsafe
   *  outside production; production requires the runner. */
  sandbox: SandboxConfig;
  /** Approval card deadline (GUILD_APPROVAL_TIMEOUT_MS, default 5 min);
   *  the gate auto-denies when it lapses. */
  approvalTimeoutMs: number;
  /** Machine-tool dispatch deadline (GUILD_CLIENT_TOOL_TIMEOUT_MS, default
   *  5 min). */
  clientToolTimeoutMs: number;
  /** Base delay of the durable generation retry backoff
   *  (GUILD_RETRY_BASE_DELAY_MS, default 2000 — pi-durable's own default).
   *  Tests lower it so a 404-wrapped-as-502 does not cost 2+4+8 seconds. */
  retryBaseDelayMs: number;
  /** Exec-policy base rules file (GUILD_EXEC_POLICY_RULES). Default: the
   *  bundled assets/exec_policy_base.rules. */
  execPolicyRulesPath: string | null;
  /** Trace payload capture (GUILD_TRACE_PAYLOADS, default on): the
   *  llm_payloads request/response bodies. Set GUILD_TRACE_PAYLOADS=0 to
   *  keep the span metadata (agent_spans) without the bodies. */
  tracePayloads: boolean;
  /** How often an active OIDC user's IdP link is replayed to ask the
   *  provider whether the account still exists
   *  (GUILD_IDP_RECHECK_SECONDS, default 900; 0 disables the recheck). */
  idpRecheckSeconds: number;
  /** Worker-per-chat mode: "on" forks a worker per active chat and the
   *  server holds no harness; "off" (default) runs everything in-process. */
  workerMode: "off" | "on";
  /** Most forked workers alive at once (GUILD_WORKER_LIMIT, default 16). */
  workerLimit: number;
  /** How long an idle worker lives before it is reaped
   *  (GUILD_WORKER_IDLE_MS, default 5 min). */
  workerIdleMs: number;
  /** The bun binary workers fork under (GUILD_BUN_BIN). Null: the server's
   *  own runtime when it is bun, else `bun` from PATH. */
  bunBin: string | null;
  /** Host root of plain chats' in-process sandbox dirs
   *  (GUILD_SANDBOX_ROOT, default /tmp/guild-sandboxes). */
  sandboxRoot: string;
  /** Routine scheduler loop (GUILD_AGENTS_SCHEDULER=off disables it).
   *  Default: on in the server, off under NODE_ENV=test. */
  agentsScheduler: boolean;
  /** Deepest agent-tree node a spawn may create (GUILD_AGENT_MAX_DEPTH,
   *  default 3). A root thread has depth 0. */
  agentMaxDepth: number;
  /** Most child threads one node may own (GUILD_AGENT_MAX_CHILDREN,
   *  default 16). Children are counted per thread node, not per run. */
  agentMaxChildrenPerNode: number;
}

export type SandboxConfig = { mode: "runner"; runnerUrl: string; runnerToken: string } | { mode: "inprocess-unsafe" };

export function parseSandboxConfig(env: NodeJS.ProcessEnv): SandboxConfig {
  const runnerUrl = env.GUILD_SANDBOX_RUNNER_URL;
  const production = env.NODE_ENV === "production";
  const mode = env.GUILD_SANDBOX ?? (runnerUrl ? "runner" : "inprocess-unsafe");
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
  throw new Error(`GUILD_SANDBOX must be runner or inprocess-unsafe (got ${mode})`);
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
  } catch {
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

/** Values the example config ships. They are public, so a production deploy
 *  that still carries one has a known secret. */
const PLACEHOLDER_SECRETS = new Set([
  "0".repeat(64),
  "change-me",
  "change-me-internal-key",
  "change-me-sandbox-runner-token",
]);

function rejectPlaceholder(value: string, label: string, production: boolean): void {
  if (production && PLACEHOLDER_SECRETS.has(value)) {
    throw new Error(`${label} is still the example placeholder; generate a real secret`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const bind = parseBindAddr(env.GUILD_BIND_ADDR ?? DEFAULT_BIND_ADDR);
  const clickhouseUrl = parseUrl(env.GUILD_CLICKHOUSE_URL ?? DEFAULT_CLICKHOUSE_URL, "GUILD_CLICKHOUSE_URL");
  const masterKeyHex = parseMasterKey(requireEnv(env, "GUILD_MASTER_KEY_HEX"));
  const jwtSecret = requireEnv(env, "GUILD_JWT_SECRET");
  const production = env.NODE_ENV === "production";
  rejectPlaceholder(masterKeyHex, "GUILD_MASTER_KEY_HEX", production);
  rejectPlaceholder(jwtSecret, "GUILD_JWT_SECRET", production);
  const apiUrl = (env.GUILD_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
  const internalKey = env.GUILD_INTERNAL_KEY ?? null;
  if (internalKey !== null) rejectPlaceholder(internalKey, "GUILD_INTERNAL_KEY", production);
  const selfBaseUrl = parseUrl(env.GUILD_SELF_BASE_URL ?? `http://127.0.0.1:${bind.port}`, "GUILD_SELF_BASE_URL");
  const faroUrl = env.GUILD_FARO_URL ?? DEFAULT_FARO_URL;
  const webDistDir =
    env.GUILD_WEB_DIST === undefined || env.GUILD_WEB_DIST === "" ? defaultWebDistDir() : env.GUILD_WEB_DIST;
  const sandbox = parseSandboxConfig(env);
  if (sandbox.mode === "runner") {
    rejectPlaceholder(sandbox.runnerToken, "GUILD_SANDBOX_RUNNER_TOKEN", production);
  }
  const allowShellTools =
    env.GUILD_ALLOW_SHELL_TOOLS === undefined || env.GUILD_ALLOW_SHELL_TOOLS === ""
      ? sandbox.mode === "runner"
      : env.GUILD_ALLOW_SHELL_TOOLS === "1";
  const approvalTimeoutMs = positiveInt(env, "GUILD_APPROVAL_TIMEOUT_MS", 300_000);
  const clientToolTimeoutMs = positiveInt(env, "GUILD_CLIENT_TOOL_TIMEOUT_MS", 300_000);
  const poolMax = positiveInt(env, "GUILD_POOL_MAX", 10);
  // Absolute: the workspace root and sandbox root must not depend on the
  // server process's cwd (pi-durable re-resolves tool cwds against it).
  const dataDir = path.resolve(env.GUILD_DATA_DIR ?? "./data");
  const tracePayloads = env.GUILD_TRACE_PAYLOADS !== "0";
  return {
    serverVersion: GUILD_TS_SERVER_VERSION,
    serverCommit: serverManifest.guildBuildCommit,
    faroUrl,
    webDistDir,
    controlDistDir: env.GUILD_CONTROL_DIST || path.resolve(process.cwd(), "../control-center/dist"),
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
    releaseRepository: env.GUILD_RELEASE_REPOSITORY || null,
    poolMax,
    dataDir,
    agentWorkspaceRoot: env.GUILD_AGENT_WORKSPACE_ROOT || "/workspaces",
    agentWorkspaceWriteRoot: env.GUILD_AGENT_WORKSPACE_WRITE_ROOT || env.GUILD_AGENT_WORKSPACE_ROOT || "/workspaces",
    allowShellTools,
    sandbox,
    approvalTimeoutMs,
    clientToolTimeoutMs,
    retryBaseDelayMs: positiveInt(env, "GUILD_RETRY_BASE_DELAY_MS", 2000),
    idpRecheckSeconds: nonNegativeInt(env, "GUILD_IDP_RECHECK_SECONDS", 900),
    execPolicyRulesPath: env.GUILD_EXEC_POLICY_RULES || null,
    tracePayloads,
    // Worker-per-chat: when "on", the server holds no harness — admission
    // routes over IPC to a forked worker per active chat (see
    // worker/supervisor.ts).
    workerMode: env.GUILD_WORKER_MODE === "on" ? ("on" as const) : ("off" as const),
    workerLimit: positiveInt(env, "GUILD_WORKER_LIMIT", 16),
    workerIdleMs: positiveInt(env, "GUILD_WORKER_IDLE_MS", 300_000),
    bunBin: env.GUILD_BUN_BIN || null,
    sandboxRoot: env.GUILD_SANDBOX_ROOT || "/tmp/guild-sandboxes",
    // Routine scheduler: explicit off wins; explicit on wins; tests default
    // off so a suite never starts a loop unless it asks for one.
    agentsScheduler:
      env.GUILD_AGENTS_SCHEDULER === "off"
        ? false
        : env.GUILD_AGENTS_SCHEDULER === "on"
          ? true
          : (env.NODE_ENV ?? process.env.NODE_ENV) !== "test",
    agentMaxDepth: positiveInt(env, "GUILD_AGENT_MAX_DEPTH", 3),
    agentMaxChildrenPerNode: positiveInt(env, "GUILD_AGENT_MAX_CHILDREN", 16),
  };
}

/** A positive integer env setting; unset or empty takes `fallback`, and
 *  anything else that is not a positive integer refuses to start. */
function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/** A non-negative integer env setting; unset or empty takes `fallback`.
 *  Zero is a value ("off"), not an error. */
function nonNegativeInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got "${raw}"`);
  }
  return value;
}

/** The env var a forked worker reads its whole config from. */
const WORKER_CONFIG_ENV = "GUILD_WORKER_CONFIG";
/** The env var naming the one chat a worker serves. */
const WORKER_CHAT_ENV = "GUILD_WORKER_CHAT_ID";
/** A worker's own pool cap: it serves one chat. */
const WORKER_POOL_MAX = 4;

/** The fork env entries that carry the server's config to one worker: the
 *  parsed config itself, so nothing is re-derived from the environment.
 *  The worker spawns no workers of its own. */
export function workerConfigEnv(config: Config, chatId: string): Record<string, string> {
  const worker: Config = { ...config, workerMode: "off", poolMax: WORKER_POOL_MAX };
  return { [WORKER_CONFIG_ENV]: JSON.stringify(worker), [WORKER_CHAT_ENV]: chatId };
}

/** A forked worker's config and chat, as the supervisor passed them. */
export function loadWorkerConfig(env: NodeJS.ProcessEnv): { config: Config; chatId: string } {
  const raw = env[WORKER_CONFIG_ENV];
  const chatId = env[WORKER_CHAT_ENV];
  if (!raw || !chatId) {
    throw new Error(
      `${WORKER_CONFIG_ENV} and ${WORKER_CHAT_ENV} are not set — this entry is forked by the supervisor only`,
    );
  }
  return { config: JSON.parse(raw) as Config, chatId };
}
