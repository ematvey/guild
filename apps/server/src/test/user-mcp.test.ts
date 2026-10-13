// User-owned MCP servers: the store (encrypted headers, masked previews),
// the session-auth CRUD + probe routes (validation, SSRF literal guard,
// cross-user isolation), and the chat runtime (per-turn discovery, the
// mcp_<server>_<tool> declarations, call-time execution) against the real
// app + harness + mock provider and the fixture MCP server.

import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import { startMcpFixtureServer } from "./fixtures/mcp-server.mjs";
import { setupM2Stack, TEST_PASSWORD, type M2Stack } from "./platform/m2-harness.js";
import { UserMcpStore } from "../platform/store/userMcp.js";
import { encryptSecret, masterKeyBytes } from "../platform/crypto.js";

const TEST_TIMEOUT = 120_000;

let stack: M2Stack;
let fixture: Server;
let fixtureBase = "";
let port: number;
let orgId: string;
let memberToken: string;
let member2Token = "";
let member2Id = "";
const sandboxRoot = mkdtempSync(path.join(tmpdir(), "guild-mcp-sandbox-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "guild-mcp-data-"));

let store: UserMcpStore;
let master: Buffer;

const toolCallSse = (name: string, args: string): string =>
  'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_mcp","type":"function","function":{"name":"' +
  name +
  '","arguments":' +
  JSON.stringify(args) +
  "}}]}}]}\n\n" +
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n' +
  "data: [DONE]\n\n";

const finalSse =
  'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"all done"}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n' +
  "data: [DONE]\n\n";

beforeAll(async () => {
  // The fixture MCP server on an ephemeral port.
  fixture = await startMcpFixtureServer(0, "127.0.0.1");
  fixtureBase = `http://127.0.0.1:${(fixture.address() as AddressInfo).port}`;

  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => (error === undefined ? resolve() : reject(error))));
  stack = await setupM2Stack(
    {
      GUILD_SELF_BASE_URL: `http://127.0.0.1:${port}`,
      GUILD_SANDBOX_ROOT: sandboxRoot,
      GUILD_DATA_DIR: dataDir,
      GUILD_ALLOW_SHELL_TOOLS: "1",
      GUILD_CLIENT_TOOL_TIMEOUT_MS: "8000",
    },
    { dbPrefix: "guild_user_mcp_test", logLevel: process.env.MCP_TEST_LOG ?? "error" },
  );
  await stack.env.app.listen({ port, host: "127.0.0.1" });
  await stack.routeModel("GLM-Test-Model");
  orgId = stack.orgId;
  memberToken = stack.memberToken;

  // A second member (cross-user isolation).
  const { hashPassword } = await import("../platform/crypto.js");
  const member2IdRow = crypto.randomUUID();
  member2Id = member2IdRow;
  await stack.env.db.query(
    "INSERT INTO users (id, org_id, email, password_hash, role, identity_type) VALUES ($1, $2, $3, $4, 'member', 'managed')",
    [member2Id, orgId, `mcp-member2-${crypto.randomUUID()}@example.test`, await hashPassword(TEST_PASSWORD)],
  );
  const loginRes = await stack.env.app.inject({
    method: "POST",
    url: "/api/v1/auth/login",
    headers: { "content-type": "application/json" },
    payload: { email: (await stack.env.db.query("SELECT email FROM users WHERE id = $1", [member2Id])).rows[0]!.email, password: TEST_PASSWORD },
  });
  member2Token = (JSON.parse(loginRes.body) as { token: string }).token;

  store = new UserMcpStore(stack.env.db);
  master = masterKeyBytes(stack.env.config.masterKeyHex);
}, 60_000);

afterAll(async () => {
  await stack.close();
  await new Promise<void>((resolve) => fixture.close(() => resolve()));
}, 30_000);


const auth = (token = memberToken): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

const authNoBody = (token = memberToken): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

async function waitFor(probe: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("waitFor timed out");
}

function scriptFor(...responses: { body: string }[]): void {
  stack.mock.setResponses(responses);
}

async function threadEvents(chatId: string): Promise<Record<string, unknown>[]> {
  const res = await stack.env.app.inject({
    method: "GET",
    url: `/api/v1/chats/${chatId}/thread`,
    headers: auth(),
  });
  return (JSON.parse(res.body) as { events: Record<string, unknown>[] }).events;
}

async function createChat(title: string): Promise<string> {
  const res = await stack.env.app.inject({
    method: "POST",
    url: "/api/v1/chats",
    headers: auth(),
    payload: { title },
  });
  expect(res.statusCode).toBe(200);
  return (JSON.parse(res.body) as { id: string }).id;
}

async function submitTurn(chatId: string, content: string): Promise<void> {
  const submit = await stack.env.app.inject({
    method: "POST",
    url: "/api/v1/gateway/chat",
    headers: auth(),
    payload: { chat_id: chatId, model: "GLM-Test-Model", messages: [{ role: "user", content }] },
  });
  expect(submit.statusCode).toBe(200);
}

async function turnSettled(chatId: string): Promise<void> {
  await waitFor(async () => {
    const events = await threadEvents(chatId);
    const last = events[events.length - 1];
    if (last === undefined) return false;
    const ev = last.event as { type?: string; blocks?: { type: string }[] };
    return ev.type === "assistant_message" && (ev.blocks?.some((b) => b.type === "text") ?? false);
  });
}

function toolResults(events: Record<string, unknown>[]): Record<string, unknown>[] {
  return events.filter((e) => (e.event as { type?: string }).type === "tool_result");
}

/** Seeds one user_mcp_servers row directly (bypasses the route validation —
 *  the runtime tests exercise 127.0.0.1 fixture URLs the guard rejects on
 *  the create path). */
async function seedServer(opts: {
  name: string;
  url: string;
  userId?: string;
  enabled?: boolean;
  headers?: Record<string, string>;
}): Promise<string> {
  const id = crypto.randomUUID();
  const headersEnc = opts.headers !== undefined ? Buffer.from(encryptSecret(master, JSON.stringify(opts.headers)), "utf8") : null;
  await stack.env.db.query(
    "INSERT INTO user_mcp_servers (id, org_id, user_id, name, url, headers_enc, enabled) VALUES ($1, $2, $3, $4, $5, $6, $7)",
    [id, orgId, opts.userId ?? stack.memberId, opts.name, opts.url, headersEnc, opts.enabled ?? true],
  );
  return id;
}

// ---------- store ----------

describe("user mcp store", () => {
  it("creates, lists, gets, updates, deletes rows scoped to the user", async () => {
    const created = await store.create(orgId, stack.memberId, "storetest", "https://mcp.example.test/sse", { authorization: "Bearer abc" }, true, master);
    expect(created.name).toBe("storetest");
    expect(created.url).toBe("https://mcp.example.test/sse");
    expect(created.enabled).toBe(true);

    const listed = await store.list(orgId, stack.memberId);
    expect(listed.some((r) => r.id === created.id)).toBe(true);
    // Another user in the same org sees nothing.
    expect((await store.list(orgId, member2Id)).some((r) => r.id === created.id)).toBe(false);

    const updated = await store.update(orgId, stack.memberId, created.id, { enabled: false }, master);
    expect(updated?.enabled).toBe(false);
    expect((await store.listEnabled(orgId, stack.memberId)).some((r) => r.id === created.id)).toBe(false);

    expect(await store.delete(orgId, stack.memberId, created.id)).toBe(true);
    expect(await store.get(orgId, stack.memberId, created.id)).toBeNull();
  });

  it("enforces unique names per user", async () => {
    await store.create(orgId, stack.memberId, "dupname", "https://a.example.test", undefined, true, master);
    await expect(store.create(orgId, stack.memberId, "dupname", "https://b.example.test", undefined, true, master)).rejects.toThrow();
    // A different user may reuse the name.
    const other = await store.create(orgId, member2Id, "dupname", "https://b.example.test", undefined, true, master);
    await store.delete(orgId, member2Id, other.id);
    const mine = (await store.list(orgId, stack.memberId)).find((r) => r.name === "dupname")!;
    await store.delete(orgId, stack.memberId, mine.id);
  });

  it("round-trips encrypted headers and masks the previews", async () => {
    const created = await store.create(orgId, stack.memberId, "hdrtest", "https://mcp.example.test", { authorization: "Bearer verysecrettoken9", "x-api-key": "plainkey1234567890" }, true, master);
    expect(store.resolveHeaders(created.headers_enc, master)).toEqual({
      authorization: "Bearer verysecrettoken9",
      "x-api-key": "plainkey1234567890",
    });
    // Wrong key never decrypts (GCM auth failure) — degraded to empty.
    const wrongKey = masterKeyBytes("33".repeat(32));
    expect(store.resolveHeaders(created.headers_enc, wrongKey)).toEqual({});
    const previews = store.previews(created.headers_enc, master);
    expect(previews).toEqual([
      { name: "authorization", masked: "Bearer ••••••••••••••••" },
      { name: "x-api-key", masked: "••••••••••••••••••" },
    ]);
    await store.delete(orgId, stack.memberId, created.id);
  });
});

// ---------- routes ----------

describe("user mcp routes", () => {
  it("requires a session", async () => {
    const res = await stack.env.app.inject({ method: "GET", url: "/api/v1/mcp/servers" });
    expect(res.statusCode).toBe(401);
  });

  it("creates, lists with masked headers, updates, deletes", async () => {
    const create = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/mcp/servers",
      headers: auth(),
      payload: { name: "routetest", url: "https://mcp.example.test/mcp", headers: { authorization: "Bearer sekritvalue9" } },
    });
    expect(create.statusCode).toBe(200);
    const created = (JSON.parse(create.body) as { server: { id: string; headers: { name: string; masked: string }[] } }).server;
    expect(created.headers).toEqual([{ name: "authorization", masked: "Bearer ••••••••••••" }]);
    expect(create.body).not.toContain("sekritvalue9");

    const list = await stack.env.app.inject({ method: "GET", url: "/api/v1/mcp/servers", headers: auth() });
    expect((JSON.parse(list.body) as { servers: { id: string }[] }).servers.some((s) => s.id === created.id)).toBe(true);

    const patch = await stack.env.app.inject({
      method: "PATCH",
      url: `/api/v1/mcp/servers/${created.id}`,
      headers: auth(),
      payload: { enabled: false },
    });
    expect(patch.statusCode).toBe(200);
    expect((JSON.parse(patch.body) as { server: { enabled: boolean } }).server.enabled).toBe(false);

    const otherGet = await stack.env.app.inject({
      method: "PATCH",
      url: `/api/v1/mcp/servers/${created.id}`,
      headers: auth(member2Token),
      payload: { enabled: true },
    });
    expect(otherGet.statusCode).toBe(404);

    const del = await stack.env.app.inject({ method: "DELETE", url: `/api/v1/mcp/servers/${created.id}`, headers: authNoBody() });
    expect(del.statusCode).toBe(200);
    const del2 = await stack.env.app.inject({ method: "DELETE", url: `/api/v1/mcp/servers/${created.id}`, headers: authNoBody() });
    expect(del2.statusCode).toBe(404);
  });

  it("validates names, urls, and the reserved namespaces", async () => {
    for (const name of ["Bad-Name", "-lead", "a".repeat(65), "bash", "read", "write", "edit", "codemode", "read_skill", "search_skills", "push_skill", "tool_search", "int_foo"]) {
      const res = await stack.env.app.inject({
        method: "POST",
        url: "/api/v1/mcp/servers",
        headers: auth(),
        payload: { name, url: "https://mcp.example.test" },
      });
      expect(res.statusCode, `name ${name}`).toBe(400);
    }
    for (const url of ["not-a-url", "ftp://mcp.example.test", "http://127.0.0.1:9000", "http://10.1.2.3", "http://172.16.0.9", "http://10.0.0.4", "http://169.254.169.254", "http://[::1]:9000", "http://[fe80::1]"]) {
      const res = await stack.env.app.inject({
        method: "POST",
        url: "/api/v1/mcp/servers",
        headers: auth(),
        payload: { name: "urltest", url },
      });
      expect(res.statusCode, `url ${url}`).toBe(400);
    }
    // DNS names are never resolved — the compose deployment's
    // host.docker.internal passes the literal check.
    const named = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/mcp/servers",
      headers: auth(),
      payload: { name: "hostname-ok", url: "http://host.docker.internal:8765/mcp" },
    });
    expect(named.statusCode).toBe(200);
    const id = (JSON.parse(named.body) as { server: { id: string } }).server.id;
    await stack.env.app.inject({ method: "DELETE", url: `/api/v1/mcp/servers/${id}`, headers: authNoBody() });
  });

  it("rejects duplicate names with 409", async () => {
    const first = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/mcp/servers",
      headers: auth(),
      payload: { name: "conflicttest", url: "https://a.example.test" },
    });
    expect(first.statusCode).toBe(200);
    const second = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/mcp/servers",
      headers: auth(),
      payload: { name: "conflicttest", url: "https://b.example.test" },
    });
    expect(second.statusCode).toBe(409);
    const other = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/mcp/servers",
      headers: auth(member2Token),
      payload: { name: "conflicttest", url: "https://b.example.test" },
    });
    expect(other.statusCode).toBe(200);
  });

  it("allows private literals only with GUILD_MCP_ALLOW_PRIVATE=1", async () => {
    process.env.GUILD_MCP_ALLOW_PRIVATE = "1";
    try {
      const res = await stack.env.app.inject({
        method: "POST",
        url: "/api/v1/mcp/servers",
        headers: auth(),
        payload: { name: "private-ok", url: "http://127.0.0.1:9000/mcp" },
      });
      expect(res.statusCode).toBe(200);
      const id = (JSON.parse(res.body) as { server: { id: string } }).server.id;
      await stack.env.app.inject({ method: "DELETE", url: `/api/v1/mcp/servers/${id}`, headers: authNoBody() });
    } finally {
      delete process.env.GUILD_MCP_ALLOW_PRIVATE;
    }
  });

  it("probes the fixture server (ok) and a dead port (ok:false, HTTP 200)", async () => {
    const okId = await seedServer({ name: "probeok", url: fixtureBase, headers: { "x-test": "v" } });
    const ok = await stack.env.app.inject({ method: "POST", url: `/api/v1/mcp/servers/${okId}/probe`, headers: auth(), payload: {} });
    expect(ok.statusCode).toBe(200);
    const okBody = JSON.parse(ok.body) as { ok: boolean; tools: { name: string }[]; error?: string };
    expect(okBody.ok).toBe(true);
    expect(okBody.tools.map((t) => t.name).sort()).toEqual(["add", "echo"]);

    // The dead-port row needs a private literal URL — seeded directly, so
    // the route probe path runs against it without the guard's blessing.
    process.env.GUILD_MCP_ALLOW_PRIVATE = "1";
    try {
      const deadId = await seedServer({ name: "probedead", url: `http://127.0.0.1:9/mcp` });
      const dead = await stack.env.app.inject({ method: "POST", url: `/api/v1/mcp/servers/${deadId}/probe`, headers: auth(), payload: {} });
      expect(dead.statusCode).toBe(200);
      const deadBody = JSON.parse(dead.body) as { ok: boolean; error: string };
      expect(deadBody.ok).toBe(false);
      expect(deadBody.error).toContain("mcp handshake failed");
      await stack.env.app.inject({ method: "DELETE", url: `/api/v1/mcp/servers/${deadId}`, headers: authNoBody() });
    } finally {
      delete process.env.GUILD_MCP_ALLOW_PRIVATE;
    }

    // The tools listing rides the same probe path.
    const tools = await stack.env.app.inject({ method: "GET", url: `/api/v1/mcp/servers/${okId}/tools`, headers: auth() });
    expect((JSON.parse(tools.body) as { ok: boolean }).ok).toBe(true);
    await stack.env.app.inject({ method: "DELETE", url: `/api/v1/mcp/servers/${okId}`, headers: authNoBody() });
  });
});

// ---------- chat runtime ----------

describe("user mcp chat runtime", () => {
  it(
    "declares the fixture server's tools, executes a call, and carries the prompt index",
    async () => {
      await seedServer({ name: "testsvr", url: fixtureBase, headers: { authorization: "Bearer turnsecret9" } });
      const chatId = await createChat("mcp-declare");
      scriptFor(
        { body: toolCallSse("mcp_testsvr_add", JSON.stringify({ a: 2, b: 3 })) },
        { body: finalSse },
      );
      await submitTurn(chatId, "add two numbers with my mcp server");
      await turnSettled(chatId);

      // The tool call landed and the joined text result came back.
      const events = await threadEvents(chatId);
      const result = toolResults(events)[0]!;
      expect((result.event as { is_error: boolean }).is_error).toBe(false);
      expect((result.event as { content: string }).content).toBe("5");

      // The system prompt carries the index line; the request declared the
      // wire tool names.
      const modelReq = stack.mock.requests[0]!.body as { messages: { role: string; content: string }[] };
      const system = modelReq.messages.find((m) => m.role === "system")?.content ?? "";
      expect(system).toContain("MCP testsvr: 2 tools");
    },
    TEST_TIMEOUT,
  );

  it(
    "degrades an unreachable server to a diagnostic line and still submits the turn",
    async () => {
      // Port 1 on 127.0.0.1: nothing listens, ECONNREFUSED is immediate.
      await seedServer({ name: "deadsvr", url: "http://127.0.0.1:9/mcp" });
      const chatId = await createChat("mcp-dead");
      scriptFor({ body: finalSse });
      await submitTurn(chatId, "hello");
      await turnSettled(chatId);

      const modelReq = stack.mock.requests.at(-1)!.body as { messages: { role: string; content: string }[] };
      const system = modelReq.messages.find((m) => m.role === "system")?.content ?? "";
      expect(system).toContain("MCP deadsvr: unreachable (");
      expect(system).not.toContain("mcp_deadsvr_");
    },
    TEST_TIMEOUT,
  );

  it(
    "keeps a disabled server absent from the declarations and the index",
    async () => {
      await seedServer({ name: "offsvr", url: fixtureBase, enabled: false });
      const chatId = await createChat("mcp-off");
      scriptFor({ body: finalSse });
      await submitTurn(chatId, "hello");
      await turnSettled(chatId);

      const modelReq = stack.mock.requests.at(-1)!.body as { messages: { role: string; content: string }[] };
      const system = modelReq.messages.find((m) => m.role === "system")?.content ?? "";
      expect(system).not.toContain("offsvr");
    },
    TEST_TIMEOUT,
  );
});
