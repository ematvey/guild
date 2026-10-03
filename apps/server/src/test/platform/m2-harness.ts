// M2 gateway test harness: disposable Postgres database (verbatim Rust
// migrations applied in order, namespaced `guild_m2_test_*` so the M1 and
// durable-storage suites coexist) + a disposable ClickHouse database on the
// same server (usage/quota tests) + a scripted mock provider upstream and a
// built app instance.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import pg from "pg";
import { buildApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import { MIGRATIONS_DIR, TEST_ADMIN_URL } from "./harness.js";

const TEST_CLICKHOUSE_URL =
  process.env.GUILD_M2_TEST_CLICKHOUSE_URL ?? "http://localhost:8123";
const TEST_CLICKHOUSE_USER = process.env.GUILD_M2_TEST_CLICKHOUSE_USER ?? "ch_user";
const TEST_CLICKHOUSE_PASSWORD =
  process.env.GUILD_M2_TEST_CLICKHOUSE_PASSWORD ?? "ch_passwd";

function randomSuffix(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface M2TestEnv {
  databaseName: string;
  clickhouseDatabase: string;
  /** Pool on the DISPOSABLE database (seeding/preparation). */
  db: pg.Pool;
  app: Awaited<ReturnType<typeof buildApp>>;
  config: ReturnType<typeof loadConfig>;
  cleanup(): Promise<void>;
}

/** Creates a disposable ClickHouse database and returns its name. */
async function createClickhouseDatabase(): Promise<string> {
  const name = `guild_m2_test_${randomSuffix()}`;
  const res = await fetch(TEST_CLICKHOUSE_URL, {
    method: "POST",
    headers: {
      "X-ClickHouse-User": TEST_CLICKHOUSE_USER,
      "X-ClickHouse-Key": TEST_CLICKHOUSE_PASSWORD,
    },
    body: `CREATE DATABASE "${name}"`,
  });
  if (!res.ok) throw new Error(`clickhouse CREATE DATABASE failed: ${await res.text()}`);
  return name;
}

async function dropClickhouseDatabase(name: string): Promise<void> {
  try {
    await fetch(TEST_CLICKHOUSE_URL, {
      method: "POST",
      headers: {
        "X-ClickHouse-User": TEST_CLICKHOUSE_USER,
        "X-ClickHouse-Key": TEST_CLICKHOUSE_PASSWORD,
      },
      body: `DROP DATABASE IF EXISTS "${name}"`,
    });
  } catch {
    // cleanup is best-effort; the Postgres drop below is the important part
  }
}

export async function createM2TestEnv(
  withClickhouse = true,
  logLevel = "error",
  configOverrides: Record<string, string> = {},
): Promise<M2TestEnv> {
  const suffix = randomSuffix();
  const databaseName = `guild_m2_test_${suffix}`;
  const adminPool = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 1 });
  await adminPool.query(`CREATE DATABASE "${databaseName}"`);
  const databaseUrl = new URL(TEST_ADMIN_URL);
  databaseUrl.pathname = `/${databaseName}`;

  // Seeding/preparation pool on the disposable database — never on the
  // shared guild database the admin URL points at.
  const dbPool = new pg.Pool({ connectionString: databaseUrl.toString(), max: 4 });
  const migrationPool = new pg.Pool({ connectionString: databaseUrl.toString(), max: 2 });
  for (const file of readdirSync(MIGRATIONS_DIR).sort()) {
    if (!file.endsWith(".sql")) continue;
    await migrationPool.query(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
  }
  await migrationPool.end();

  const clickhouseDatabase = withClickhouse ? await createClickhouseDatabase() : "guild";

  // The usage_events table: created eagerly in the disposable database with
  // the same DDL the sink issues on connect (the Rust sink creates it on
  // AppState::usage() — before any seeded usage the quota tests read).
  const { ClickhouseClient } = await import("../../platform/clickhouse.js");
  const ch = new ClickhouseClient({
    url: TEST_CLICKHOUSE_URL,
    database: clickhouseDatabase,
    user: TEST_CLICKHOUSE_USER,
    password: TEST_CLICKHOUSE_PASSWORD,
  });
  await ch.ensureUsageTable();

  const config = loadConfig({
    GUILD_DATABASE_URL: databaseUrl.toString(),
    GUILD_MASTER_KEY_HEX: "22".repeat(32),
    GUILD_JWT_SECRET: "m2-test-jwt-secret",
    GUILD_API_URL: "http://localhost:18080",
    GUILD_LOG_LEVEL: logLevel,
    GUILD_CLICKHOUSE_URL: TEST_CLICKHOUSE_URL,
    GUILD_CLICKHOUSE_DATABASE: clickhouseDatabase,
    GUILD_CLICKHOUSE_USER: TEST_CLICKHOUSE_USER,
    GUILD_CLICKHOUSE_PASSWORD: TEST_CLICKHOUSE_PASSWORD,
    GUILD_INTERNAL_KEY: `gk_internal_${suffix}`,
    ...configOverrides,
  });
  const app = await buildApp(config);

  let done = false;
  const cleanup = async (): Promise<void> => {
    if (done) return;
    done = true;
    await app.close();
    await dbPool.end();
    if (withClickhouse) await dropClickhouseDatabase(clickhouseDatabase);
    const dropper = new pg.Pool({ connectionString: TEST_ADMIN_URL, max: 1 });
    try {
      // WITH (FORCE) can transiently fail ("permission denied to terminate
      // process") when a backend exits as the signal lands under parallel
      // load — retry.
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
    await adminPool.end();
  };

  return {
    databaseName,
    clickhouseDatabase,
    db: dbPool,
    app,
    config,
    cleanup,
  };
}

// ---------- mock provider upstream ----------

export interface MockUpstreamRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
}

export interface MockUpstream {
  url: string;
  requests: MockUpstreamRequest[];
  stop(): Promise<void>;
}

/** A scripted provider upstream: each POST to any path is answered with the
 *  next response (SSE bodies passed verbatim); request bodies are recorded.
 *  GETs (stray loopback probes) get a 404. */
export async function startMockUpstream(
  responses: { status?: number; contentType?: string; body: string }[],
): Promise<MockUpstream> {
  const requests: MockUpstreamRequest[] = [];
  let call = 0;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        body = { raw };
      }
      requests.push({ path: req.url ?? "/", headers: req.headers, body });
      const scripted = responses[Math.min(call, responses.length - 1)]!;
      call += 1;
      res.writeHead(scripted.status ?? 200, {
        "content-type": scripted.contentType ?? "text/event-stream",
      });
      res.end(scripted.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("mock upstream bind failed");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// ---------- shared test setup ----------

export const TEST_PASSWORD = "m2-test-Pw1!";

export interface M2Stack {
  env: M2TestEnv;
  orgId: string;
  adminEmail: string;
  adminToken: string;
  memberToken: string;
  /** Plaintext gateway API key owned by the member. */
  apiKey: string;
  apiKeyId: string;
  adminId: string;
  memberId: string;
  mock: MockUpstream;
  /** Registers the mock upstream as the org's provider + a route for
   *  `model`. */
  routeModel(model: string, opts?: { protocol?: string; quotaMonthlyUsd?: number | null; priceIn?: number; priceOut?: number }): Promise<void>;
  /** Inserts a usage event directly into the disposable ClickHouse. */
  seedUsage(opts: {
    model: string;
    costUsd: number;
    tokensIn?: number;
    tokensOut?: number;
    /** Row count (aggregate replays need exact request counts). */
    rows?: number;
    provider?: string;
  }): Promise<void>;
  /** Waits for ClickHouse to make a direct insert visible. */
  drain(): Promise<void>;
  usageRows(): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

/** Full stack: disposable PG + CH + app + org/users/session/key + mock
 *  provider. The provider row is registered against the mock upstream.
 *  `configOverrides` pass through to loadConfig (e.g. GUILD_SELF_BASE_URL). */
export async function setupM2Stack(configOverrides: Record<string, string> = {}): Promise<M2Stack> {
  const env = await createM2TestEnv(true, "error", configOverrides);
  const db = env.db;
  const orgId = crypto.randomUUID();
  const adminEmail = `m2-admin-${randomSuffix()}@example.test`;
  const memberEmail = `m2-member-${randomSuffix()}@example.test`;
  await db.query("INSERT INTO orgs (id, name) VALUES ($1, 'm2 test org')", [orgId]);
  // Seed users with argon2 hashes computed through the platform crypto
  // (same algorithm login verify uses).
  const { hashPassword } = await import("../../platform/crypto.js");
  const hash = await hashPassword(TEST_PASSWORD);
  const adminId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  await db.query(
    "INSERT INTO users (id, org_id, email, password_hash, role, identity_type) VALUES " +
      "($1, $2, $3, $4, 'admin', 'managed'), ($5, $2, $6, $4, 'member', 'managed')",
    [adminId, orgId, adminEmail, hash, memberId, memberEmail],
  );
  const adminToken = await login(env, adminEmail);
  const memberToken = await login(env, memberEmail);

  // Mint the gateway API key for the member.
  const keyRes = await env.app.inject({
    method: "POST",
    url: "/api/v1/api-keys",
    headers: { authorization: `Bearer ${memberToken}`, "content-type": "application/json" },
    payload: { name: "m2-test" },
  });
  if (keyRes.statusCode !== 200) throw new Error(`api key mint failed: ${keyRes.body}`);
  const keyBody = JSON.parse(keyRes.body) as { key: { id: string }; plaintext: string };

  // Default scripted response: a minimal OpenAI SSE turn (used whenever a
  // test doesn't install its own script).
  const mock = await startMockUpstream([
    {
      body:
        'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
        'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\n' +
        "data: [DONE]\n\n",
    },
  ]);

  const stack: M2Stack = {
    env,
    orgId,
    adminEmail,
    adminToken,
    memberToken,
    apiKey: keyBody.plaintext,
    apiKeyId: keyBody.key.id,
    adminId,
    memberId,
    mock,
    async routeModel(model, opts = {}) {
      const prov = await env.app.inject({
        method: "POST",
        url: "/api/v1/admin/gateway/providers",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        payload: {
          name: opts.protocol === "anthropic" ? "Mock Anthropic" : "Mock OpenAI",
          protocol: opts.protocol ?? "openai",
          base_url: mock.url,
          key: "sk-mock",
        },
      });
      if (prov.statusCode !== 200 && prov.statusCode !== 409) {
        throw new Error(`provider create failed: ${prov.statusCode} ${prov.body}`);
      }
      const route = await env.app.inject({
        method: "PUT",
        url: "/api/v1/admin/gateway/routes",
        headers: { authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        payload: {
          model,
          provider: opts.protocol === "anthropic" ? "mock-anthropic" : "mock-openai",
          price_in: opts.priceIn ?? 2.0,
          price_out: opts.priceOut ?? 4.0,
          quota_monthly_usd: opts.quotaMonthlyUsd === undefined ? null : opts.quotaMonthlyUsd,
        },
      });
      if (route.statusCode !== 200) {
        throw new Error(`route create failed: ${route.statusCode} ${route.body}`);
      }
    },
    async seedUsage(opts) {
      // Direct insert into the disposable ClickHouse database (same
      // columns the Rust UsageRow writes).
      const count = opts.rows ?? 1;
      const lines: string[] = [];
      for (let i = 0; i < count; i += 1) {
        lines.push(
          JSON.stringify({
            ts: new Date().toISOString().slice(0, 19).replace("T", " "),
            org_id: orgId,
            user_id: memberId,
            team_id: null,
            session_id: crypto.randomUUID(),
            model: opts.model,
            provider: opts.provider ?? "mock-openai",
            tokens_in: opts.tokensIn ?? 1000,
            tokens_out: opts.tokensOut ?? 1000,
            cost_usd: opts.costUsd,
            request_id: crypto.randomUUID(),
          }),
        );
      }
      const res = await fetch(`${TEST_CLICKHOUSE_URL}/?database=${env.clickhouseDatabase}`, {
        method: "POST",
        headers: {
          "X-ClickHouse-User": TEST_CLICKHOUSE_USER,
          "X-ClickHouse-Key": TEST_CLICKHOUSE_PASSWORD,
          "content-type": "text/plain; charset=utf-8",
        },
        body: `INSERT INTO usage_events FORMAT JSONEachRow\n${lines.join("\n")}`,
      });
      if (!res.ok) throw new Error(`usage seed failed: ${await res.text()}`);
    },
    async drain() {
      // Wait for the usage sink's async inserts to land: fixed sleeps race
      // under parallel-suite load — poll until the org's row count is
      // stable across two consecutive reads (bounded).
      await new Promise((resolve) => setTimeout(resolve, 400));
      let last = -1;
      for (let i = 0; i < 20; i++) {
        const rows = await this.usageRows();
        if (rows.length === last) return;
        last = rows.length;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    },
    async usageRows() {
      const res = await fetch(`${TEST_CLICKHOUSE_URL}/?database=${env.clickhouseDatabase}`, {
        method: "POST",
        headers: {
          "X-ClickHouse-User": TEST_CLICKHOUSE_USER,
          "X-ClickHouse-Key": TEST_CLICKHOUSE_PASSWORD,
        },
        body: `SELECT * FROM usage_events WHERE org_id = toUUID('${orgId}') ORDER BY ts, request_id FORMAT JSONEachRow`,
      });
      const text = await res.text();
      return text
        .trim()
        .split("\n")
        .filter((l) => l !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    },
    async close() {
      await mock.stop();
      await env.cleanup();
    },
  };
  return stack;
}

async function login(env: M2TestEnv, email: string): Promise<string> {
  const res = await env.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { "content-type": "application/json" },
    payload: { email, password: TEST_PASSWORD },
  });
  if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
  return (JSON.parse(res.body) as { token: string }).token;
}

// The plain M1 harness module is re-used for MIGRATIONS_DIR/TEST_ADMIN_URL;
// its own test env builder stays M1-specific.
export { MIGRATIONS_DIR, TEST_ADMIN_URL };
