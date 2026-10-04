// M7 capture: boot the REAL Rust server (target/debug/guild-server) against
// a disposable Postgres DB and record the exact wire behavior of the
// integration routes the TS port must mirror:
//   - POST /api/v1/integrations/{slug}/tools/{tool} with the connector
//     backend unreachable (the "runtime down" failure shape),
//   - the approval-policy validation rejection texts (me/approval),
//   - the script-API auth/policy failures (401/403/404 envelope shapes).
// Read-only against the live stack; everything happens on guild_m7_capture_*.

import { Pool } from "pg";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 18190;
const BASE = `http://127.0.0.1:${PORT}`;
const MASTER_KEY = "44".repeat(32);

function sh(cmd: string): string {
  const { execSync } = require("node:child_process") as typeof import("node:child_process");
  return execSync(cmd, { encoding: "utf8" });
}

async function main(): Promise<void> {
  const dbName = `guild_m7_capture_${Math.random().toString(36).slice(2, 8)}`;
  const admin = new Pool({ connectionString: "postgres://guild:guild@localhost:5432/postgres" });
  await admin.query(`CREATE DATABASE ${dbName}`);
  const dataDir = mkdtempSync(join(tmpdir(), "m7-capture-"));
  let server: ChildProcess | undefined;
  const out: Record<string, unknown> = {};
  try {
    server = spawn(join(process.cwd(), "../../target/debug/guild-server"), [], {
      env: {
        ...process.env,
        GUILD_ROLE: "api",
        GUILD_BIND_ADDR: `127.0.0.1:${PORT}`,
        GUILD_DATABASE_URL: `postgres://guild:guild@localhost:5432/${dbName}`,
        GUILD_MASTER_KEY_HEX: MASTER_KEY,
        GUILD_JWT_SECRET: "m7-capture-secret",
        GUILD_S3_URL: "http://127.0.0.1:9950",
        GUILD_S3_BUCKET: "guild",
        GUILD_S3_ACCESS_KEY_ID: "rustfsadmin",
        GUILD_S3_SECRET_ACCESS_KEY: "rustfsadmin",
        GUILD_CLICKHOUSE_URL: "http://127.0.0.1:8123",
        GUILD_CLICKHOUSE_DATABASE: "guild",
        GUILD_CLICKHOUSE_USER: "ch_user",
        GUILD_CLICKHOUSE_PASSWORD: "x",
        GUILD_API_URL: BASE,
        GUILD_DATA_DIR: dataDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    server.stderr!.on("data", (d: Buffer) => process.stderr.write(d));

    // Wait for readiness.
    let up = false;
    for (let i = 0; i < 120; i++) {
      try {
        const res = await fetch(`${BASE}/api/v1/health`);
        if (res.ok) {
          up = true;
          break;
        }
      } catch {
        /* not yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!up) throw new Error("rust server did not come up");

    const post = async (path: string, token: string | null, body?: unknown, extraHeaders: Record<string, string> = {}) => {
      const res = await fetch(`${BASE}${path}`, {
        method: "POST",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, contentType: res.headers.get("content-type"), body: await res.text() };
    };
    const put = async (path: string, token: string, body: unknown) => {
      const res = await fetch(`${BASE}${path}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, contentType: res.headers.get("content-type"), body: await res.text() };
    };
    const get = async (path: string, token: string | null) => {
      const res = await fetch(`${BASE}${path}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      return { status: res.status, contentType: res.headers.get("content-type"), body: await res.text() };
    };

    // Bootstrap an org admin, then log in (bootstrap returns {} only).
    const boot = await post("/api/v1/auth/bootstrap", null, {
      email: "admin@m7.test",
      password: "password-admin",
    });
    out.bootstrap = boot;
    const login = await post("/api/v1/auth/login", null, {
      email: "admin@m7.test",
      password: "password-admin",
    });
    const token = (JSON.parse(login.body) as { token?: string })["token"];
    if (typeof token !== "string") throw new Error(`bootstrap failed: ${boot.body}`);

    // Script-API auth shapes.
    out.execute_unauthenticated = await post("/api/v1/integrations/searxng/tools/web_search", null, {});
    // A built-in connector with its backend unreachable: stub-create first
    // (no connection test), then capture the enable save's test failure.
    const cfg = { base_url: "http://127.0.0.1:1" }; // closed port — unreachable
    const save = await post("/api/v1/admin/integrations", token, { name: "searxng" });
    out.save_searxng_stub = save;
    const rows = JSON.parse((await get("/api/v1/admin/integrations", token)).body) as {
      integrations: { id: string; name: string }[];
    };
    const searxng = rows.integrations.find((r) => r.name === "searxng");
    out.admin_tools_builtin = await get(`/api/v1/admin/integrations/${searxng!.id}/tools`, token);
    // Enable save with a connection test through the (down) backend → 400.
    const upd = await fetch(`${BASE}/api/v1/admin/integrations/${searxng!.id}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, config: cfg }),
    });
    out.save_enable_unreachable = { status: upd.status, body: await upd.text() };
    // Force-enable in the DB so the execute route resolves the plugin.
    const db = new Pool({ connectionString: `postgres://guild:guild@localhost:5432/${dbName}` });
    await db.query(
      "UPDATE integrations SET enabled = true, config = $1 WHERE name = 'searxng'",
      [JSON.stringify(cfg)],
    );
    out.execute_runtime_down = await post("/api/v1/integrations/searxng/tools/web_search", token, { query: "test" });
    out.execute_wrong_tool = await post("/api/v1/integrations/searxng/tools/nope", token, {});
    out.execute_wrong_integration = await post("/api/v1/integrations/nope/tools/x", token, {});
    out.execute_bad_body = await post("/api/v1/integrations/searxng/tools/web_search", token, "not-json-object");
    // Always-ask curation → forbidden (the script API is non-interactive).
    await db.query(
      "UPDATE integrations SET config = $1 WHERE name = 'searxng'",
      [JSON.stringify({ base_url: cfg.base_url, tools: { web_search: { enabled: true, approval: "always_ask" } } })],
    );
    out.execute_always_ask = await post("/api/v1/integrations/searxng/tools/web_search", token, { query: "t" });
    out.execute_namespaced_raw = await post("/api/v1/integrations/searxng/tools/searxng_web_search", token, { query: "t" });

    // Script listing shapes (empty + with one plugin).
    out.list_integrations = await get("/api/v1/integrations", token);
    out.list_tools = await get("/api/v1/integrations/searxng/tools", token);
    out.list_tools_unknown = await get("/api/v1/integrations/nope/tools", token);

    // Approval-policy validation rejection texts.
    out.approval_get_empty = await get("/api/v1/me/approval", token);
    out.approval_put_valid = await put("/api/v1/me/approval", token, { default: "ask", overrides: { web_search: "never" } });
    out.approval_put_bad_variant = await put("/api/v1/me/approval", token, { default: "sometimes" });
    out.approval_put_bad_type = await put("/api/v1/me/approval", token, { default: 5 });
    out.approval_put_bad_overrides = await put("/api/v1/me/approval", token, { overrides: [] });
    out.approval_put_clear = await put("/api/v1/me/approval", token, { approval: null });
    out.approval_put_bare = await put("/api/v1/me/approval", token, { default: "allow" });
    await db.end();
    console.log(JSON.stringify(out, null, 2));
  } finally {
    server?.kill("SIGTERM");
    await admin.query(`DROP DATABASE ${dbName} WITH (FORCE)`);
    rmSync(dataDir, { recursive: true, force: true });
    await admin.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
