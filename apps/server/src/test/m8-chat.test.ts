// M8 chat-loop registration: the integrations runtime against the real app
// + harness + mock provider. Per turn the runtime installs the org's
// integration extension (list_tools/guide autos + curated connector tools)
// into the durable conversation, the scripted model drives discovery and a
// real connector tool against a local mock backend, and the audit event lands.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupM2Stack, type M2Stack } from "./platform/m2-harness.js";

const TEST_TIMEOUT = 120_000;

let stack: M2Stack;
let port: number;
let orgId: string;
let memberToken: string;
const sandboxRoot = mkdtempSync(path.join(tmpdir(), "guild-m8-sandbox-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "guild-m8-data-"));

const toolCallSse = (name: string, args: string): string => {
  args = JSON.stringify({ code: `return await tools[${JSON.stringify(name)}](${args});` });
  name = "codemode";
  return 'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_m8","type":"function","function":{"name":"' +
  name +
  '","arguments":' +
  JSON.stringify(args) +
  "}}]}}]}\n\n" +
  'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n' +
  "data: [DONE]\n\n";
};

const finalSse =
  'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
  'data: {"choices":[{"delta":{"content":"all done"}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n' +
  "data: [DONE]\n\n";

// ---------- local mock vendor backend (atlassian + slack) ----------

let vendor: Server;
let vendorBase = "";

function route(_req: IncomingMessage, url: URL): { status: number; body: string } {
  const p = url.pathname;
  if (p === "/rest/api/3/search/jql") {
    return {
      status: 200,
      body: JSON.stringify({ issues: [{ key: "PROJ-1", fields: { summary: "First", status: { name: "Open" }, issuetype: { name: "Bug" }, assignee: { displayName: "Alice" } } }] }),
    };
  }
  if (p === "/rest/api/3/issue/PROJ-1") {
    return { status: 200, body: JSON.stringify({ key: "PROJ-1", fields: { summary: "First", status: { name: "Open" }, issuetype: { name: "Bug" }, assignee: { displayName: "Alice" } } }) };
  }
  if (p === "/api/chat.postMessage") {
    return { status: 200, body: JSON.stringify({ ok: true, channel: "C1", ts: "1760000000.000100" }) };
  }
  return { status: 404, body: "{}" };
}

beforeAll(async () => {
  vendor = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://vendor.test");
      const out = route(req, url);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => vendor.listen(0, "127.0.0.1", resolve));
  vendorBase = `http://127.0.0.1:${(vendor.address() as AddressInfo).port}`;

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
      GUILD_APPROVAL_TIMEOUT_MS: "3000",
      GUILD_CLIENT_TOOL_TIMEOUT_MS: "8000",
    },
    { dbPrefix: "guild_m8_chat_test", logLevel: process.env.M8_TEST_LOG ?? "error" },
  );
  await stack.env.app.listen({ port, host: "127.0.0.1" });
  await stack.routeModel("GLM-Test-Model");
  orgId = stack.orgId;
  memberToken = stack.memberToken;

  // Seed atlassian (token secret) + slack with a read tool and an
  // always_allow-curated write tool (org governance overrides the gate —
  // the call flows with no card).
  const { masterKeyBytes, encryptSecret } = await import("../platform/crypto.js");
  const master = masterKeyBytes(stack.env.config.masterKeyHex);
  await stack.env.db.query(
    "INSERT INTO integrations (org_id, name, config, enabled) VALUES ($1, 'atlassian', $2, true) ON CONFLICT (org_id, name) DO UPDATE SET config = EXCLUDED.config",
    [orgId, JSON.stringify({ site: vendorBase, email: "bot@example.test" })],
  );
  await stack.env.db.query(
    "INSERT INTO integration_secrets (org_id, integration, name, secret_enc) VALUES ($1, 'atlassian', 'token', $2) ON CONFLICT (org_id, integration, name) DO NOTHING",
    [orgId, encryptSecret(master, "atlassian-token")],
  );
  await stack.env.db.query(
    "INSERT INTO integrations (org_id, name, config, enabled) VALUES ($1, 'slack', $2, true) ON CONFLICT (org_id, name) DO UPDATE SET config = EXCLUDED.config",
    [orgId, JSON.stringify({ base_url: `${vendorBase}/api`, tools: { conversations_list: { enabled: true, approval: "always_ask" }, post_message: { enabled: true, approval: "always_allow" } } })],
  );
  await stack.env.db.query(
    "INSERT INTO integration_secrets (org_id, integration, name, secret_enc) VALUES ($1, 'slack', 'bot_token', $2) ON CONFLICT (org_id, integration, name) DO NOTHING",
    [orgId, encryptSecret(master, "xoxb-1")],
  );
}, 60_000);

afterAll(async () => {
  await stack.close();
  await new Promise<void>((resolve) => vendor.close(() => resolve()));
}, 30_000);

const auth = (token = memberToken): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
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

async function threadEvents(chatId: string, token = memberToken): Promise<Record<string, unknown>[]> {
  const res = await stack.env.app.inject({
    method: "GET",
    url: `/api/v1/chats/${chatId}/thread`,
    headers: auth(token),
  });
  if (res.statusCode !== 200) throw new Error(`thread GET ${res.statusCode}: ${res.body}`);
  return (JSON.parse(res.body) as { events: Record<string, unknown>[] }).events;
}

async function createChat(title: string, token = memberToken): Promise<string> {
  const res = await stack.env.app.inject({
    method: "POST",
    url: "/api/v1/chats",
    headers: auth(token),
    payload: { title },
  });
  expect(res.statusCode).toBe(200);
  return (JSON.parse(res.body) as { id: string }).id;
}

async function submitTurn(chatId: string, content: string, token = memberToken): Promise<void> {
  const submit = await stack.env.app.inject({
    method: "POST",
    url: "/api/v1/gateway/chat",
    headers: auth(token),
    payload: { chat_id: chatId, model: "GLM-Test-Model", messages: [{ role: "user", content }] },
  });
  expect(submit.statusCode).toBe(200);
}

async function turnSettled(chatId: string, token = memberToken): Promise<void> {
  await waitFor(async () => {
    const events = await threadEvents(chatId, token);
    const last = events[events.length - 1];
    if (last === undefined) return false;
    const ev = last.event as { type?: string; blocks?: { type: string }[] };
    return ev.type === "assistant_message" && (ev.blocks?.some((b) => b.type === "text") ?? false);
  });
}

/** Tool-call blocks ride assistant_message events (like the m4 flow). */
function toolCalls(events: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const e of events) {
    const ev = e.event as { type?: string; blocks?: { type: string }[] };
    if (ev.type !== "assistant_message") continue;
    for (const block of ev.blocks ?? []) {
      if (block.type === "tool_call") out.push(block as unknown as Record<string, unknown>);
    }
  }
  return out;
}

function toolResults(events: Record<string, unknown>[]): Record<string, unknown>[] {
  return events.filter((e) => (e.event as { type?: string }).type === "tool_result");
}

describe("M8: integrations chat runtime", () => {
  it(
    "registers list_tools + guide + connector tools; discovery returns the member-visible specs",
    async () => {
      const chatId = await createChat("m8-discovery");
      scriptFor(
        { body: toolCallSse("atlassian_list_tools", "{}") },
        { body: finalSse },
      );
      await submitTurn(chatId, "what atlassian tools do I have?");
      await turnSettled(chatId);

      const events = await threadEvents(chatId);
      const call = toolCalls(events).find((b) => (b as { name: string }).name === "codemode");
      expect(call).toBeDefined();
      const result = toolResults(events).find((e) => (e.event as { call_id: string }).call_id === (call as { id: string }).id);
      expect(result).toBeDefined();
      expect((result!.event as { is_error: boolean }).is_error).toBe(false);
      const specs = JSON.parse((result!.event as { content: string }).content.split("Output:\n")[1]!) as Record<string, unknown>[];
      const names = specs.map((s) => s["name"]);
      // Read-class connector tools for the member; write-class tools
      // (confluence_create_page, api) are role-filtered out; the list_tools
      // JSON carries connector specs only (the guide auto is a registered
      // tool, not a spec).
      for (const expected of ["atlassian_jira_search", "atlassian_jira_get_issue", "atlassian_confluence_search", "atlassian_confluence_get_page"]) {
        expect(names).toContain(expected);
      }
      expect(names).not.toContain("atlassian_confluence_create_page");
      expect(names).not.toContain("atlassian_api");
      // The spec shape: name, description, parameters — no rust kind field.
      const spec = specs.find((s) => s["name"] === "atlassian_jira_search")!;
      expect(typeof spec["description"]).toBe("string");
      expect((spec["parameters"] as Record<string, unknown>)["type"]).toBe("object");
      expect(spec["kind"]).toBeUndefined();

      // Auto tools are not audited; the runtime extension is in the system
      // prompt (the tool result meta carries the guild wiring).
      await turnSettled(chatId);
    },
    TEST_TIMEOUT,
  );

  it(
    "executes a connector tool from the chat and journals the audit event",
    async () => {
      const chatId = await createChat("m8-execute");
      scriptFor(
        { body: toolCallSse("atlassian_jira_search", JSON.stringify({ jql: "project = PROJ", max_results: 3 })) },
        { body: finalSse },
      );
      await submitTurn(chatId, "find the PROJ issues");

      await turnSettled(chatId);
      const events = await threadEvents(chatId);
      const result = toolResults(events)[0]!;
      expect((result.event as { is_error: boolean }).is_error).toBe(false);
      expect((result.event as { content: string }).content).toContain("PROJ-1 — First [Open] (Alice)");
      const audit = await stack.env.db.query(
        "SELECT payload FROM events WHERE kind = 'integration.tool_called' ORDER BY created_at DESC LIMIT 1",
      );
      const payload = audit.rows[0]!.payload as Record<string, unknown>;
      expect(payload).toMatchObject({
        slug: "atlassian",
        tool: "jira_search",
        via: "chat",
        ok: true,
      });
      expect(payload["caller"]).toBeTypeOf("string");
      expect(payload["acting_as"]).toBeTypeOf("string");
    },
    TEST_TIMEOUT,
  );

  it(
    "an always_allow-curated write-class tool flows without an approval card",
    async () => {
      // post_message is write-class: the default curation would fall
      // through to the chat's approval mode (an unresolved policy asks via
      // the judge). The always_allow curation skips the gate entirely —
      // the org's grant wins over the user policy, no card, no judge.
      const chatId = await createChat("m8-always-allow", stack.adminToken);
      scriptFor(
        { body: toolCallSse("slack_post_message", JSON.stringify({ channel: "C1", text: "hello from the test" })) },
        { body: finalSse },
      );
      await submitTurn(chatId, "post to slack", stack.adminToken);
      await turnSettled(chatId, stack.adminToken);

      const events = await threadEvents(chatId, stack.adminToken);
      expect(events.find((e) => (e.event as { type?: string }).type === "approval_request")).toBeUndefined();
      const call = toolCalls(events).find((b) => (b as { name: string }).name === "codemode");
      expect(call).toBeDefined();
      const result = toolResults(events).find((e) => (e.event as { call_id: string }).call_id === (call as { id: string }).id);
      expect(result).toBeDefined();
      expect((result!.event as { is_error: boolean }).is_error).toBe(false);
      expect((result!.event as { content: string }).content).toContain("1760000000.000100");
    },
    TEST_TIMEOUT,
  );
});
