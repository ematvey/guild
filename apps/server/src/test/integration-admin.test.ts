// Integration admin: the script-facing integration tool API, the admin
// integration save path (config validation, secret merge, connection tests
// against local fake connector/MCP servers), the tools listing, and the
// /api/v1/me/approval policy surface — against a disposable database. The
// wire shapes are pinned by the fixed capture in
// platform/fixtures/integration-admin-capture.json.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { InjectPayload } from "light-my-request";
import { createObjectStoreStack, packBundle, type ObjectStoreStack } from "./support/object-store-stack.js";

const PASSWORD = "hunter227";
const CAPTURE = JSON.parse(
  readFileSync(path.join(process.cwd(), "src/test/platform/fixtures/integration-admin-capture.json"), "utf8"),
) as Record<string, { status: number; body: string }>;

interface Env {
  env: ObjectStoreStack;
  adminToken: string;
  memberToken: string;
  orgId: string;
}

let e: Env;
let connectorServer: Server;
let connectorHits: string[] = [];
let mcpServer: Server;
/** The headers of the fake MCP server's last request. */
let mcpLastHeaders: Record<string, unknown> = {};

beforeAll(async () => {
  const env = await createObjectStoreStack("error", {}, "m7");
  const orgId = crypto.randomUUID();
  const adminId = crypto.randomUUID();
  const memberId = crypto.randomUUID();
  const suffix = crypto.randomUUID().slice(0, 8);
  const adminEmail = `m7-admin-${suffix}@example.test`;
  const memberEmail = `m7-member-${suffix}@example.test`;
  const { hashPassword } = await import("../platform/crypto.js");
  const hash = await hashPassword(PASSWORD);
  await env.db.query("INSERT INTO orgs (id, name) VALUES ($1, 'm7 test org')", [orgId]);
  await env.db.query(
    "INSERT INTO users (id, org_id, email, password_hash, role, identity_type) VALUES " +
      "($1, $2, $3, $4, 'admin', 'managed'), ($5, $2, $6, $4, 'member', 'managed')",
    [adminId, orgId, adminEmail, hash, memberId, memberEmail],
  );
  const login = async (email: string): Promise<string> => {
    const res = await env.app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      headers: { "content-type": "application/json" },
      payload: { email, password: PASSWORD },
    });
    if (res.statusCode !== 200) throw new Error(`login failed: ${res.body}`);
    return (JSON.parse(res.body) as { token: string }).token;
  };
  e = { env, adminToken: await login(adminEmail), memberToken: await login(memberEmail), orgId };

  // Local fake connector backend: tests point connector configs at it.
  connectorServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    connectorHits.push(req.url ?? "");
    if ((req.url ?? "").includes("unauthorized")) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end("{}");
      return;
    }
    if ((req.url ?? "").startsWith("/search")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          results: [
            { title: "First result", url: "https://example.com/a", content: "snippet a" },
            { title: "Second result", url: "https://example.com/b", content: "snippet b" },
          ],
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok": true}');
  });
  await new Promise<void>((resolve) => connectorServer.listen(0, "127.0.0.1", resolve));

  // Minimal fake MCP server (streamable HTTP): initialize + tools/list.
  mcpServer = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") {
      res.writeHead(req.method === "DELETE" ? 200 : 405);
      res.end();
      return;
    }
    mcpLastHeaders = req.headers;
    // The /auth-mcp path stands in for a third-party server: it wants a
    // bearer token in Authorization.
    if ((req.url ?? "").startsWith("/auth-mcp") && req.headers["authorization"] !== "Bearer s3cret") {
      res.writeHead(401);
      res.end();
      return;
    }
    let body = "";
    req.on("data", (c: Buffer) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body) as { id?: number; method: string };
      if (msg.method === "initialize") {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess-1" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } },
          }),
        );
        return;
      }
      if (msg.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      if (msg.method === "tools/call") {
        const args = (msg as { params?: { arguments?: { text?: string } } }).params?.arguments ?? {};
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: { content: [{ type: "text", text: `echo:${args.text ?? ""}` }], isError: false },
          }),
        );
        return;
      }
      if (msg.method === "tools/list") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              tools: [
                {
                  name: "echo",
                  description: "Echo the input.",
                  inputSchema: { type: "object", properties: { text: { type: "string" } } },
                  annotations: { readOnlyHint: true },
                },
                { name: "write_thing", description: "Write something.", inputSchema: { type: "object" } },
              ],
            },
          }),
        );
        return;
      }
      res.writeHead(400);
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => mcpServer.listen(0, "127.0.0.1", resolve));
}, 120_000);

afterAll(async () => {
  await e?.env.cleanup();
  await new Promise<void>((resolve) => connectorServer.close(() => resolve()));
  await new Promise<void>((resolve) => mcpServer.close(() => resolve()));
}, 60_000);

function connectorBase(): string {
  return `http://127.0.0.1:${(connectorServer.address() as AddressInfo).port}`;
}

function mcpUrl(): string {
  return `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/mcp`;
}

async function call(
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  token?: string,
  payload?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ statusCode: number; body: string; headers: Record<string, unknown> }> {
  const res = await e.env.app.inject({
    method,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(payload !== undefined ? { "content-type": "application/json" } : {}),
      ...extraHeaders,
    },
    ...(payload !== undefined ? { payload: payload as InjectPayload } : {}),
  });
  return { statusCode: res.statusCode, body: res.body, headers: res.headers };
}

/** Seeds (or replaces) one integration row + optional secrets; returns the
 *  row id. The row's audience is every member at read, which is what
 *  existing Integrations migrated to; a test of the audience narrows it. */
async function seedIntegration(
  name: string,
  config: unknown,
  enabled: boolean,
  secrets: Record<string, string> = {},
): Promise<string> {
  const res = await e.env.db.query(
    "INSERT INTO integrations (org_id, name, config, enabled, audience) VALUES ($1, $2, $3, $4, 'org') " +
      "ON CONFLICT (org_id, name) DO UPDATE SET config = EXCLUDED.config, enabled = EXCLUDED.enabled " +
      "RETURNING id",
    [e.orgId, name, JSON.stringify(config ?? {}), enabled],
  );
  const id = res.rows[0]!.id as string;
  const { masterKeyBytes, encryptSecret } = await import("../platform/crypto.js");
  const master = masterKeyBytes(e.env.config.masterKeyHex);
  for (const [secretName, value] of Object.entries(secrets)) {
    await e.env.db.query(
      "INSERT INTO integration_secrets (org_id, integration, name, secret_enc) VALUES ($1, $2, $3, $4) " +
        "ON CONFLICT (org_id, integration, name) DO UPDATE SET secret_enc = EXCLUDED.secret_enc",
      [e.orgId, name, secretName, encryptSecret(master, value)],
    );
  }
  return id;
}

/** Opens an installed Integration to every member at read: a new one is
 *  for admins only. */
async function openToMembers(name: string): Promise<void> {
  await e.env.db.query("UPDATE integrations SET audience = 'org' WHERE org_id = $1 AND name = $2", [e.orgId, name]);
}

/** Publishes + approves a v2 MCP plugin in the registry, then installs it
 *  (the install creates the integration row + a disabled routine). */
async function installMcpPlugin(slug: string, url: string): Promise<void> {
  const manifest = {
    kind: "integration",
    slug,
    version: "1.0.0",
    description: `Test MCP plugin ${slug}`,
    mcp: { url },
    auth: { kind: "org_secret", secret_names: ["api_key"], identity_key: "email" },
    tools: { classes: { echo: "read", write_thing: "write" } },
  };
  const bundle = await packBundle({ "manifest.json": JSON.stringify(manifest) });
  const pub = await call("POST", `/api/v1/registry/integration?slug=${slug}&version=1.0.0`, e.adminToken, bundle, {
    "content-type": "application/octet-stream",
  });
  if (pub.statusCode !== 200) throw new Error(`registry publish failed: ${pub.body}`);
  const approve = await call("POST", `/api/v1/registry/integration/${slug}/review`, e.adminToken, {
    status: "approved",
    reviewed_version: "1.0.0",
    reviewed_bundle_sha256: createHash("sha256").update(bundle).digest("hex"),
  });
  if (approve.statusCode !== 200) throw new Error(`registry review failed: ${approve.body}`);
  const install = await call("POST", `/api/v1/registry/integration/${slug}/install`, e.memberToken, {});
  if (install.statusCode !== 200) throw new Error(`registry install failed: ${install.body}`);
}

// ---------- script-facing integration tool API ----------

describe("script API auth", () => {
  it("401 without a bearer token, in the Rust envelope", async () => {
    const res = await call("GET", "/api/v1/integrations");
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual(JSON.parse(CAPTURE.execute_unauthenticated.body));
  });

  it("401 with an unknown token", async () => {
    const res = await call("GET", "/api/v1/integrations", "nope");
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).error.message).toBe("invalid credentials");
  });

  it("an org API key authenticates (the key's owner is the acting principal)", async () => {
    const mint = await call("POST", "/api/v1/api-keys", e.memberToken, { name: "scripts" });
    expect(mint.statusCode).toBe(200);
    const { plaintext } = JSON.parse(mint.body) as { plaintext: string };
    const res = await call("GET", "/api/v1/integrations", plaintext);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).items).toEqual([]);
  });
});

describe("GET /api/v1/integrations + /{slug}/tools", () => {
  beforeAll(async () => {
    await seedIntegration("searxng", { base_url: connectorBase() }, true);
  });

  it("lists enabled plugins policy-filtered to a count — byte-identical to the Rust capture", async () => {
    const res = await call("GET", "/api/v1/integrations", e.adminToken);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      items: [{ description: "Web search through a SearxNG instance", slug: "searxng", tool_count: 1 }],
    });
  });

  it("lists the policy-filtered tool catalog with schemas and classes — a trait tool carries the Guild-provided name", async () => {
    const res = await call("GET", "/api/v1/integrations/searxng/tools", e.adminToken);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      tools: { name: string; class: string; description: string; parameters: unknown }[];
    };
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({ name: "web_search", class: "read" });
    expect(body.tools[0].description).toContain("Search the public web");
    expect(body.tools[0].parameters).toMatchObject({ required: ["query"] });
  });

  it("404 for an unknown slug, exactly like Rust", async () => {
    const res = await call("GET", "/api/v1/integrations/nope/tools", e.adminToken);
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual(JSON.parse(CAPTURE.list_tools_unknown.body));
  });

  it("a member sees only the tools the class rule allows", async () => {
    await seedIntegration("github", { api_url: connectorBase() }, true, { token: "gh-token" });
    const admin = await call("GET", "/api/v1/integrations/github/tools", e.adminToken);
    const member = await call("GET", "/api/v1/integrations/github/tools", e.memberToken);
    expect(
      JSON.parse(admin.body)
        .tools.map((t: { name: string }) => t.name)
        .sort(),
    ).toEqual([
      "github_api",
      "github_create_issue",
      "github_get_file",
      "github_list_issues",
      "github_list_pulls",
      "github_search_repositories",
    ]);
    const memberNames = JSON.parse(member.body).tools.map((t: { name: string }) => t.name);
    expect(memberNames).not.toContain("github_api");
    expect(memberNames).not.toContain("github_create_issue");
    expect(memberNames).toHaveLength(4);
  });

  it("per-tool curation hides a disabled tool from the catalog", async () => {
    await seedIntegration(
      "gitlab",
      { base_url: connectorBase(), tools: { list_mrs: { enabled: false, approval: "default" } } },
      true,
      { token: "gl-token" },
    );
    const member = await call("GET", "/api/v1/integrations/gitlab/tools", e.memberToken);
    const names = JSON.parse(member.body).tools.map((t: { name: string }) => t.name);
    expect(names).not.toContain("gitlab_list_mrs");
  });
});

describe("POST /api/v1/integrations/{slug}/tools/{tool} (execute)", () => {
  beforeAll(async () => {
    // Port 1 is closed: a real connector dispatch fails at the transport.
    await seedIntegration("searxng", { base_url: "http://127.0.0.1:1" }, true);
  });

  it("a connector transport failure is a result (200, ok:false), never an HTTP error", async () => {
    const res = await call("POST", "/api/v1/integrations/searxng/tools/web_search", e.adminToken, { query: "test" });
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/^searxng unreachable: /);
    expect(Object.keys(parsed).sort()).toEqual(["error", "ok"]);
  });

  it("executes a connector tool through the runtime against the fake backend (real dispatch)", async () => {
    // Row names are the connector slugs (org-unique): the live-backend test
    // re-points the searxng row at the fake server.
    await seedIntegration("searxng", { base_url: connectorBase() }, true);
    const res = await call("POST", "/api/v1/integrations/searxng/tools/web_search", e.adminToken, {
      query: "guild",
      count: 1,
    });
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body) as { ok: boolean; content: string; meta: Record<string, unknown> | null };
    expect(parsed.ok).toBe(true);
    expect(parsed.content).toContain("1. First result");
    expect(parsed.content).not.toContain("Second result");
    expect(parsed.meta).toMatchObject({ card: "web", kind: "search", truncated: true });
    const audit = await e.env.db.query(
      "SELECT payload FROM events WHERE kind = 'integration.tool_called' AND payload->>'slug' = 'searxng' ORDER BY created_at DESC LIMIT 1",
    );
    expect((audit.rows[0]!.payload as Record<string, unknown>)["ok"]).toBe(true);
  });

  it("404 shapes for unknown integration and unknown tool, exactly like Rust", async () => {
    const unknownIntegration = await call("POST", "/api/v1/integrations/nope/tools/x", e.adminToken, {});
    expect(JSON.parse(unknownIntegration.body)).toEqual(JSON.parse(CAPTURE.execute_wrong_integration.body));
    const unknownTool = await call("POST", "/api/v1/integrations/searxng/tools/nope", e.adminToken, {});
    expect(JSON.parse(unknownTool.body)).toEqual(JSON.parse(CAPTURE.execute_wrong_tool.body));
  });

  it("400 for a non-object body, exactly like Rust", async () => {
    const res = await call("POST", "/api/v1/integrations/searxng/tools/web_search", e.adminToken, '"not-json-object"');
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body)).toEqual(JSON.parse(CAPTURE.execute_bad_body.body));
  });

  it("an empty body is an empty arguments object (validation passes; the runtime boundary still fails clean)", async () => {
    const res = await call("POST", "/api/v1/integrations/searxng/tools/web_search", e.adminToken);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(false);
  });

  it("a tool curated to always_ask is refused (the script API is non-interactive)", async () => {
    await seedIntegration(
      "slack",
      { base_url: connectorBase(), tools: { post_message: { enabled: true, approval: "always_ask" } } },
      true,
      { bot_token: "xoxb" },
    );
    const res = await call("POST", "/api/v1/integrations/slack/tools/post_message", e.adminToken, {
      channel: "C1",
      text: "hi",
    });
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body)).toEqual({
      error: { code: "forbidden", message: "this tool needs an approval and cannot be called from a script" },
    });
  });

  it("a write-class tool is member-forbidden; the raw connector name is accepted alongside the namespaced one", async () => {
    await seedIntegration("github", { api_url: connectorBase() }, true, { token: "gh-token" });
    const member = await call("POST", "/api/v1/integrations/github/tools/create_issue", e.memberToken, {});
    expect(member.statusCode).toBe(403);
    const adminRaw = await call("POST", "/api/v1/integrations/github/tools/api", e.adminToken, { path: "/x" });
    expect(adminRaw.statusCode).toBe(200);
    // Real dispatch: the fake backend answers GET /x with {"ok": true}.
    const adminParsed = JSON.parse(adminRaw.body) as {
      ok: boolean;
      content: string;
      meta: Record<string, unknown> | null;
    };
    expect(adminParsed.ok).toBe(true);
    expect(adminParsed.content).toBe('{"ok": true}');
    expect(adminParsed.meta).toMatchObject({ card: "api", status: 200 });
  });

  it("a member with a mapped email passes the impersonating-connector gate (acts as themselves)", async () => {
    await seedIntegration("google_workspace", {}, true, { service_account_json: "{}" });
    const res = await call("POST", "/api/v1/integrations/google_workspace/tools/gmail_search", e.memberToken, {
      query: "x",
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).ok).toBe(false); // validation passed; the runtime boundary failed
  });

  it("journales the audit event (integration.tool_called, via=script)", async () => {
    await seedIntegration("firecrawl", { base_url: "http://127.0.0.1:1" }, true, { api_key: "fc-key" });
    await call("POST", "/api/v1/integrations/firecrawl/tools/web_search", e.adminToken, { query: "journaled" });
    const res = await e.env.db.query(
      "SELECT payload FROM events WHERE kind = 'integration.tool_called' AND payload->>'slug' = 'firecrawl' ORDER BY created_at DESC LIMIT 1",
    );
    const payload = res.rows[0]!.payload as Record<string, unknown>;
    expect(payload["via"]).toBe("script");
    expect(payload["ok"]).toBe(false);
    expect(payload["caller"]).toBeTypeOf("string");
    expect(payload["call_id"]).toBeTypeOf("string");
  });
});

// ---------- admin integration CRUD (save path + tools listing) ----------

describe("admin integration save path", () => {
  it("a create-stub (name only) registers the row disabled and empty — byte-identical response shape to Rust", async () => {
    const res = await call("POST", "/api/v1/admin/integrations", e.adminToken, { name: "hubspot" });
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    expect(parsed["enabled"]).toBe(false);
    expect(parsed["config"]).toEqual({});
    expect(typeof parsed["id"]).toBe("string");
  });

  it("a duplicate create is a 409 already_configured; an unknown kind is a 404", async () => {
    const dup = await call("POST", "/api/v1/admin/integrations", e.adminToken, { name: "hubspot" });
    expect(dup.statusCode).toBe(409);
    expect(JSON.parse(dup.body).error.code).toBe("already_configured");
    const unknown = await call("POST", "/api/v1/admin/integrations", e.adminToken, { name: "not_a_connector" });
    expect(unknown.statusCode).toBe(404);
    expect(JSON.parse(unknown.body).error.message).toBe("unknown integration not_a_connector");
  });

  it("a valid save with connection test persists config + secrets (test passed against the fake backend)", async () => {
    await seedIntegration("gitlab", {}, false);
    const rows = JSON.parse((await call("GET", "/api/v1/admin/integrations", e.adminToken)).body) as {
      items: { id: string; name: string }[];
    };
    const id = rows.items.find((r) => r.name === "gitlab")!.id;
    connectorHits = [];
    const res = await call("PUT", `/api/v1/admin/integrations/${id}`, e.adminToken, {
      config: { base_url: connectorBase() },
      enabled: true,
      secrets: { token: "tok-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
    expect(connectorHits.some((h) => h.startsWith("/api/v4/user"))).toBe(true);
    const row = (await e.env.db.query("SELECT enabled, config FROM integrations WHERE id = $1", [id])).rows[0]!;
    expect(row.enabled).toBe(true);
    expect(row.config.base_url).toBe(connectorBase());
    const secretRow = (
      await e.env.db.query(
        "SELECT secret_enc, masked FROM integration_secrets WHERE org_id = $1 AND integration = 'gitlab'",
        [e.orgId],
      )
    ).rows[0]!;
    expect(secretRow.secret_enc).not.toContain("tok-1");
    expect(secretRow.masked).toBe("•".repeat(5));
  });

  it("a failing connection test is a 400 and nothing is persisted (a broken connection is never stored)", async () => {
    await seedIntegration("github", { api_url: `${connectorBase()}/unauthorized` }, false, { token: "old" });
    const rows = JSON.parse((await call("GET", "/api/v1/admin/integrations", e.adminToken)).body) as {
      items: { id: string; name: string }[];
    };
    const id = rows.items.find((r) => r.name === "github")!.id;
    const res = await call("PUT", `/api/v1/admin/integrations/${id}`, e.adminToken, {
      enabled: true,
      secrets: { token: "new" },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.message).toBe("github rejected the connection (401 Unauthorized)");
    const row = (await e.env.db.query("SELECT enabled FROM integrations WHERE id = $1", [id])).rows[0]!;
    expect(row.enabled).toBe(false); // the enable did not persist
    const secret = (
      await e.env.db.query(
        "SELECT secret_enc FROM integration_secrets WHERE org_id = $1 AND integration = 'github' AND name = 'token'",
        [e.orgId],
      )
    ).rows[0]!;
    const { masterKeyBytes, decryptSecret } = await import("../platform/crypto.js");
    expect(decryptSecret(masterKeyBytes(e.env.config.masterKeyHex), secret.secret_enc)).toBe("old"); // the new value was not written
  });

  it("enabling without the declared secrets is a 409 missing_secrets", async () => {
    await seedIntegration("hubspot", { base_url: connectorBase() }, false);
    const rows = JSON.parse((await call("GET", "/api/v1/admin/integrations", e.adminToken)).body) as {
      items: { id: string; name: string }[];
    };
    const id = rows.items.find((r) => r.name === "hubspot")!.id;
    const res = await call("PUT", `/api/v1/admin/integrations/${id}`, e.adminToken, { enabled: true });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error.code).toBe("missing_secrets");
  });

  it("a broken config is a 400 with the connector's validation text", async () => {
    await seedIntegration("slack", {}, false);
    const rows = JSON.parse((await call("GET", "/api/v1/admin/integrations", e.adminToken)).body) as {
      items: { id: string; name: string }[];
    };
    const id = rows.items.find((r) => r.name === "slack")!.id;
    const res = await call("PUT", `/api/v1/admin/integrations/${id}`, e.adminToken, { config: { base_url: 42 } });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error.message).toBe(
      "invalid integration config: slack config base_url must be a string",
    );
  });

  it("a settings save never touches the tools curation map (the PUT tools endpoint is its only writer)", async () => {
    const id = await seedIntegration(
      "langfuse",
      { base_url: connectorBase(), tools: { get_trace: { enabled: false, approval: "always_ask" } } },
      false,
      { public_key: "pk", secret_key: "sk" },
    );
    const res = await call("PUT", `/api/v1/admin/integrations/${id}`, e.adminToken, {
      config: { base_url: connectorBase(), tools: { get_trace: { enabled: true, approval: "default" } } },
      enabled: true,
    });
    expect(res.statusCode).toBe(200);
    const row = (await e.env.db.query("SELECT config FROM integrations WHERE id = $1", [id])).rows[0]!;
    expect(row.config.tools.get_trace).toEqual({ enabled: false, approval: "always_ask" }); // the stored selection rode through
  });

  it("the tools curation listing reads the connector declarations with classes", async () => {
    await seedIntegration("atlassian", { site: "https://x.atlassian.net", email: "a@b.c" }, false, { token: "t" });
    const rows = JSON.parse((await call("GET", "/api/v1/admin/integrations", e.adminToken)).body) as {
      items: { id: string; name: string }[];
    };
    const id = rows.items.find((r) => r.name === "atlassian")!.id;
    const res = await call("GET", `/api/v1/admin/integrations/${id}/tools`, e.adminToken);
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body) as {
      resolved: boolean;
      kind: string;
      tools: { name: string; tool: string; class: string; enabled: boolean; approval: string }[];
    };
    expect(parsed.resolved).toBe(true);
    expect(parsed.kind).toBe("connector");
    const names = parsed.tools.map((t) => t.name);
    expect(names).toContain("jira_search");
    expect(names).toContain("api");
    expect(parsed.tools.find((t) => t.name === "api")!.class).toBe("write");
    expect(parsed.tools.find((t) => t.name === "jira_search")!.tool).toBe("atlassian_jira_search");
    expect(parsed.tools.find((t) => t.name === "jira_search")!.approval).toBe("default");
  });
});

// ---------- MCP plugin rows (live discovery over the minimal client) ----------

describe("MCP plugin rows", () => {
  it("installing a v2 MCP plugin creates the row; the admin tools listing connects live and merges discovered tools with the stored curation", async () => {
    await installMcpPlugin("test-mcp-m7", mcpUrl());
    const rows = JSON.parse((await call("GET", "/api/v1/admin/integrations", e.adminToken)).body) as {
      items: { id: string; name: string }[];
    };
    const id = rows.items.find((r) => r.name === "test-mcp-m7")!.id;
    // Disabled (fresh install) → not resolved, no connection.
    const disabled = await call("GET", `/api/v1/admin/integrations/${id}/tools`, e.adminToken);
    expect(disabled.statusCode).toBe(200);
    expect(JSON.parse(disabled.body)).toEqual({
      resolved: false,
      kind: "mcp",
      reason: "integration disabled",
      tools: [],
    });
    // Enable: the save gate runs the full pool connect + tools/list
    // handshake with the would-be secrets before persisting.
    const enable = await call("PUT", `/api/v1/admin/integrations/${id}`, e.adminToken, {
      enabled: true,
      secrets: { api_key: "mcp-key" },
    });
    expect(enable.statusCode).toBe(200);
    const row = (await e.env.db.query("SELECT enabled FROM integrations WHERE id = $1", [id])).rows[0]!;
    expect(row.enabled).toBe(true);
    // Live listing: every discovered remote tool carries the stored
    // curation — absent = disabled (remote drift lands visible-but-off);
    // classes from the manifest.
    const listing = await call("GET", `/api/v1/admin/integrations/${id}/tools`, e.adminToken);
    expect(listing.statusCode).toBe(200);
    const parsed = JSON.parse(listing.body) as {
      resolved: boolean;
      kind: string;
      tools: { name: string; tool: string; class: string; enabled: boolean; approval: string }[];
    };
    expect(parsed.resolved).toBe(true);
    expect(parsed.kind).toBe("mcp");
    expect(parsed.tools.find((t) => t.name === "echo")!.enabled).toBe(false);
    expect(parsed.tools.find((t) => t.name === "echo")!.tool).toBe("test-mcp-m7_echo");
    const uncurated = parsed.tools.find((t) => t.name === "write_thing")!;
    expect(uncurated.enabled).toBe(false);
    expect(uncurated.class).toBe("write"); // the manifest declares it; the listing is unfiltered
    // Curation turns a discovered tool on.
    await call("PUT", `/api/v1/admin/integrations/${id}/tools/echo`, e.adminToken, {
      enabled: true,
      approval: "always_ask",
    });
    const curated = JSON.parse((await call("GET", `/api/v1/admin/integrations/${id}/tools`, e.adminToken)).body) as {
      tools: { name: string; enabled: boolean; approval: string }[];
    };
    const echoCurated = curated.tools.find((t) => t.name === "echo")!;
    expect(echoCurated.enabled).toBe(true);
    expect(echoCurated.approval).toBe("always_ask");
  });

  it("an unreachable MCP backend fails the save gate with the Rust error text", async () => {
    await installMcpPlugin("test-mcp-down", "http://127.0.0.1:1/mcp");
    const rows = JSON.parse((await call("GET", "/api/v1/admin/integrations", e.adminToken)).body) as {
      items: { id: string; name: string }[];
    };
    const id = rows.items.find((r) => r.name === "test-mcp-down")!.id;
    const res = await call("PUT", `/api/v1/admin/integrations/${id}`, e.adminToken, {
      enabled: true,
      secrets: { api_key: "k" },
    });
    expect(res.statusCode).toBe(400);
    const message = JSON.parse(res.body).error.message as string;
    expect(message).toContain("MCP server unreachable");
    expect(message).toContain("mcp"); // the transport/handshake cause rides along
    const row = (await e.env.db.query("SELECT enabled FROM integrations WHERE id = $1", [id])).rows[0]!;
    expect(row.enabled).toBe(false); // a broken connection is never stored
  });

  it("an MCP row without an approved registry manifest answers the Rust 400 (no registry manifest)", async () => {
    const id = await seedIntegration("rogue_mcp", { mcp: { url: "http://127.0.0.1:1/mcp" } }, true);
    const listing = await call("GET", `/api/v1/admin/integrations/${id}/tools`, e.adminToken);
    expect(listing.statusCode).toBe(400);
    expect(JSON.parse(listing.body).error.message).toContain("no registry manifest");
  });

  it("the script API resolves an MCP row through live discovery and serves the policy-filtered catalog", async () => {
    await installMcpPlugin("test-mcp-m7b", mcpUrl());
    const rows = JSON.parse((await call("GET", "/api/v1/admin/integrations", e.adminToken)).body) as {
      items: { id: string; name: string }[];
    };
    const id = rows.items.find((r) => r.name === "test-mcp-m7b")!.id;
    await call("PUT", `/api/v1/admin/integrations/${id}`, e.adminToken, {
      enabled: true,
      secrets: { api_key: "k" },
    });
    // Curate: echo on, write_thing (write class) admin-only by class.
    await call("PUT", `/api/v1/admin/integrations/${id}/tools/echo`, e.adminToken, {
      enabled: true,
      approval: "default",
    });
    const admin = await call("GET", "/api/v1/integrations/test-mcp-m7b/tools", e.adminToken);
    expect(admin.statusCode).toBe(200);
    const tools = JSON.parse(admin.body).tools as { name: string; class: string }[];
    // MCP tools are opt-in: only the curated-enabled tool is exposed, to
    // admins and members alike (the write-class one stays off).
    expect(tools.map((t) => t.name)).toEqual(["test-mcp-m7b_echo"]);
    const closed = await call("GET", "/api/v1/integrations/test-mcp-m7b/tools", e.memberToken);
    expect(JSON.parse(closed.body).tools).toEqual([]);
    await openToMembers("test-mcp-m7b");
    const member = await call("GET", "/api/v1/integrations/test-mcp-m7b/tools", e.memberToken);
    expect(JSON.parse(member.body).tools.map((t: { name: string }) => t.name)).toEqual(["test-mcp-m7b_echo"]);
    const list = await call("GET", "/api/v1/integrations", e.memberToken);
    const item = (JSON.parse(list.body).items as { slug: string; tool_count: number }[]).find(
      (i) => i.slug === "test-mcp-m7b",
    );
    expect(item!.tool_count).toBe(1);
    // Execute: the runtime dispatches through the MCP peer with the
    // identity envelope; the fake server echoes the arguments.
    const exec = await call("POST", "/api/v1/integrations/test-mcp-m7b/tools/echo", e.adminToken, { text: "hi" });
    expect(exec.statusCode).toBe(200);
    const parsed = JSON.parse(exec.body) as { ok: boolean; content: string; meta: unknown };
    expect(parsed.ok).toBe(true);
    expect(parsed.content).toBe("echo:hi");
    expect(parsed.meta).toBeNull();
  });
});

describe("org MCP servers added from the admin UI", () => {
  const authUrl = (): string => `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/auth-mcp`;
  const headers = [{ name: "Authorization", value: "Bearer s3cret" }];

  it("the probe reaches the server with the configured header and suggests a class per tool", async () => {
    const refused = await call("POST", "/api/v1/admin/integrations/mcp/probe", e.adminToken, { url: authUrl() });
    expect(refused.statusCode).toBe(400);
    expect(JSON.parse(refused.body).error.message).toMatch(/401/);
    const res = await call("POST", "/api/v1/admin/integrations/mcp/probe", e.adminToken, { url: authUrl(), headers });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).tools).toEqual([
      { name: "echo", description: "Echo the input.", class: "read" },
      { name: "write_thing", description: "Write something.", class: "write" },
    ]);
    const member = await call("POST", "/api/v1/admin/integrations/mcp/probe", e.memberToken, {
      url: authUrl(),
      headers,
    });
    expect(member.statusCode).toBe(403);
  });

  it("create publishes an approved manifest, stores the enabled row, and the runtime calls through the header", async () => {
    const res = await call("POST", "/api/v1/admin/integrations/mcp", e.adminToken, {
      slug: "corp-mcp",
      title: "Corp MCP",
      description: "Internal tools.",
      url: authUrl(),
      headers,
      envelope: false,
      tools: [{ name: "write_thing", enabled: false }],
    });
    expect(res.statusCode).toBe(200);
    const id = JSON.parse(res.body).id as string;

    const shop = JSON.parse((await call("GET", "/api/v1/admin/integrations", e.adminToken)).body) as {
      items: { name: string; configured: boolean; enabled: boolean; secret_names: string[]; categories: string[] }[];
    };
    const entry = shop.items.find((i) => i.name === "corp-mcp")!;
    expect(entry).toMatchObject({
      configured: true,
      enabled: true,
      secret_names: ["authorization"],
      categories: ["mcp"],
    });
    const registry = JSON.parse((await call("GET", "/api/v1/registry/integration", e.adminToken)).body) as {
      items: { slug: string; review_status: string }[];
    };
    expect(registry.items.find((i) => i.slug === "corp-mcp")!.review_status).toBe("approved");
    const secretRow = (
      await e.env.db.query(
        "SELECT secret_enc FROM integration_secrets WHERE org_id = $1 AND integration = 'corp-mcp' AND name = 'authorization'",
        [e.orgId],
      )
    ).rows[0]!;
    expect(secretRow.secret_enc).not.toContain("s3cret");

    await openToMembers("corp-mcp");
    const member = await call("GET", "/api/v1/integrations/corp-mcp/tools", e.memberToken);
    expect(JSON.parse(member.body).tools.map((t: { name: string }) => t.name)).toEqual(["corp-mcp_echo"]);
    const exec = await call("POST", "/api/v1/integrations/corp-mcp/tools/echo", e.memberToken, { text: "hi" });
    expect(JSON.parse(exec.body)).toMatchObject({ ok: true, content: "echo:hi" });
    expect(mcpLastHeaders["authorization"]).toBe("Bearer s3cret");
    expect(Object.keys(mcpLastHeaders).filter((h) => h.startsWith("x-guild-"))).toEqual([]);

    // The admin reclassifies echo as write: the member's read-only default
    // no longer reaches it.
    const put = await call("PUT", `/api/v1/admin/integrations/${id}/tools/echo`, e.adminToken, {
      enabled: true,
      approval: "default",
      class: "write",
    });
    expect(put.statusCode).toBe(200);
    const after = await call("GET", "/api/v1/integrations/corp-mcp/tools", e.memberToken);
    expect(JSON.parse(after.body).tools).toEqual([]);
    const listing = JSON.parse((await call("GET", `/api/v1/admin/integrations/${id}/tools`, e.adminToken)).body) as {
      tools: { name: string; class: string; enabled: boolean }[];
    };
    expect(listing.tools.map((t) => [t.name, t.class, t.enabled])).toEqual([
      ["echo", "write", true],
      ["write_thing", "write", false],
    ]);
    // A curation write without a class keeps the stored one.
    await call("PUT", `/api/v1/admin/integrations/${id}/tools/echo`, e.adminToken, {
      enabled: true,
      approval: "always_ask",
    });
    const kept = JSON.parse((await call("GET", `/api/v1/admin/integrations/${id}/tools`, e.adminToken)).body) as {
      tools: { name: string; class: string }[];
    };
    expect(kept.tools.find((t) => t.name === "echo")!.class).toBe("write");
  });

  it("refuses a taken slug, a built-in slug, and a class change on a built-in row", async () => {
    const dup = await call("POST", "/api/v1/admin/integrations/mcp", e.adminToken, {
      slug: "corp-mcp",
      url: authUrl(),
      headers,
    });
    expect(dup.statusCode).toBe(409);
    const builtin = await call("POST", "/api/v1/admin/integrations/mcp", e.adminToken, {
      slug: "github",
      url: authUrl(),
      headers,
    });
    expect(builtin.statusCode).toBe(409);
    const id = await seedIntegration("searxng", { base_url: "http://searx.test" }, false);
    const cls = await call("PUT", `/api/v1/admin/integrations/${id}/tools/web_search`, e.adminToken, {
      enabled: true,
      class: "admin",
    });
    expect(cls.statusCode).toBe(400);
  });
});

describe("a built-in MCP plugin's connection test and enable", () => {
  const authUrl = (): string => `http://127.0.0.1:${(mcpServer.address() as AddressInfo).port}/auth-mcp`;

  it("tests the form's unsaved key without storing it, and enables without the optional secret", async () => {
    expect((await call("POST", "/api/v1/admin/integrations", e.adminToken, { name: "stripe" })).statusCode).toBe(200);
    const row = await e.env.db.query("SELECT id, config FROM integrations WHERE org_id = $1 AND name = 'stripe'", [
      e.orgId,
    ]);
    const id = row.rows[0].id as string;
    await e.env.db.query("UPDATE integrations SET config = jsonb_set(config, '{mcp,url}', $2) WHERE id = $1", [
      id,
      JSON.stringify(authUrl()),
    ]);

    const bare = await call("POST", `/api/v1/admin/integrations/${id}/test`, e.adminToken, {});
    expect(JSON.parse(bare.body)).toEqual({ ok: false, error: "missing secrets: Agent API key" });

    const wrong = await call("POST", `/api/v1/admin/integrations/${id}/test`, e.adminToken, {
      secrets: { stripe_key: "nope" },
    });
    expect(JSON.parse(wrong.body)).toMatchObject({ ok: false, error: expect.stringMatching(/401/) });

    const draft = await call("POST", `/api/v1/admin/integrations/${id}/test`, e.adminToken, {
      secrets: { stripe_key: "s3cret" },
    });
    expect(JSON.parse(draft.body)).toMatchObject({ ok: true });
    expect(mcpLastHeaders["authorization"]).toBe("Bearer s3cret");
    expect(mcpLastHeaders["stripe-account"]).toBeUndefined();
    expect(Object.keys(mcpLastHeaders).filter((h) => h.startsWith("x-guild-"))).toEqual([]);
    const stored = await e.env.db.query(
      "SELECT name FROM integration_secrets WHERE org_id = $1 AND integration = 'stripe'",
      [e.orgId],
    );
    expect(stored.rows).toEqual([]);

    const save = await call("PUT", `/api/v1/admin/integrations/${id}`, e.adminToken, {
      enabled: true,
      secrets: { stripe_key: "s3cret" },
    });
    expect(save.statusCode).toBe(200);
    const saved = await call("POST", `/api/v1/admin/integrations/${id}/test`, e.adminToken, {});
    expect(JSON.parse(saved.body)).toMatchObject({ ok: true });
  });
});

// ---------- /api/v1/me/approval ----------

describe("GET/PUT /api/v1/me/approval", () => {
  it("GET returns null before any save (the server default governs) — like the Rust capture", async () => {
    const res = await call("GET", "/api/v1/me/approval", e.memberToken);
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(JSON.parse(CAPTURE.approval_get_empty.body));
  });

  it("PUT accepts the wrapped, bare and null shapes and persists per user", async () => {
    const wrapped = await call("PUT", "/api/v1/me/approval", e.memberToken, {
      approval: { default: "ask", overrides: { web_search: "never" } },
    });
    expect(wrapped.statusCode).toBe(200);
    expect(JSON.parse(wrapped.body)).toEqual(JSON.parse(CAPTURE.approval_put_valid.body));
    const stored = (await e.env.db.query("SELECT approval FROM users WHERE email LIKE 'm7-member-%'")).rows[0]!;
    expect(stored.approval).toEqual({ default: "ask", overrides: { web_search: "never" } });

    const bare = await call("PUT", "/api/v1/me/approval", e.adminToken, { default: "allow" });
    expect(bare.statusCode).toBe(200);
    expect(JSON.parse(bare.body)).toEqual(JSON.parse(CAPTURE.approval_put_bare.body));

    const clear = await call("PUT", "/api/v1/me/approval", e.memberToken, { approval: null });
    expect(clear.statusCode).toBe(200);
    expect(JSON.parse(clear.body)).toEqual(JSON.parse(CAPTURE.approval_put_clear.body));
    const cleared = (await e.env.db.query("SELECT approval FROM users WHERE email LIKE 'm7-member-%'")).rows[0]!;
    expect(cleared.approval).toBeNull();
  });

  it("invalid policies are rejected with the captured serde texts", async () => {
    const badVariant = await call("PUT", "/api/v1/me/approval", e.memberToken, { default: "sometimes" });
    expect(badVariant.statusCode).toBe(400);
    expect(JSON.parse(badVariant.body)).toEqual(JSON.parse(CAPTURE.approval_put_bad_variant.body));

    const badType = await call("PUT", "/api/v1/me/approval", e.memberToken, { default: 5 });
    expect(badType.statusCode).toBe(400);
    expect(JSON.parse(badType.body)).toEqual(JSON.parse(CAPTURE.approval_put_bad_type.body));

    const badOverrides = await call("PUT", "/api/v1/me/approval", e.memberToken, { overrides: [] });
    expect(badOverrides.statusCode).toBe(400);
    expect(JSON.parse(badOverrides.body)).toEqual(JSON.parse(CAPTURE.approval_put_bad_overrides.body));
  });
});
