// Integrations chat-loop registration: the integrations runtime against
// the real app + harness + mock provider. Per turn the runtime installs the
// org's integration extension (list_tools/guide autos + curated connector
// tools) into the durable conversation, the scripted model drives discovery
// and a real connector tool against a local mock backend, and the audit
// event lands.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IntegrationsRuntime } from "../harness/integrations.js";
import { setupGatewayStack, type GatewayStack } from "./support/gateway-stack.js";
import { waitFor } from "./support/wait.js";

const TEST_TIMEOUT = 120_000;

let stack: GatewayStack;
let port: number;
let orgId: string;
let memberToken: string;
const sandboxRoot = mkdtempSync(path.join(tmpdir(), "guild-m8-sandbox-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "guild-m8-data-"));

const toolCallSse = (name: string, args: string): string => {
  if (name !== "codemode") args = JSON.stringify({ code: `return await tools[${JSON.stringify(name)}](${args});` });
  name = "codemode";
  return (
    'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"call_m8","type":"function","function":{"name":"' +
    name +
    '","arguments":' +
    JSON.stringify(args) +
    "}}]}}]}\n\n" +
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
    'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n' +
    "data: [DONE]\n\n"
  );
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
let issueReads = 0;
let hubspotReads = 0;
let slackPosts = 0;
let issueDelayMs = 0;
let activeIssueReads = 0;
let peakIssueReads = 0;

function route(_req: IncomingMessage, url: URL): { status: number; body: string } {
  const p = url.pathname;
  if (p === "/crm/v3/objects/contacts/search" || /^\/crm\/v3\/lists\/\d+$/.test(p)) {
    hubspotReads++;
    return { status: 200, body: JSON.stringify({ results: [], name: "Example list" }) };
  }
  if (p === "/rest/api/3/search/jql") {
    return {
      status: 200,
      body: JSON.stringify({
        issues: [
          {
            key: "PROJ-1",
            fields: {
              summary: "First",
              status: { name: "Open" },
              issuetype: { name: "Bug" },
              assignee: { displayName: "Alice" },
            },
          },
        ],
      }),
    };
  }
  if (p === "/rest/api/3/issue/PROJ-1") {
    issueReads++;
    return {
      status: 200,
      body: JSON.stringify({
        key: "PROJ-1",
        fields: {
          summary: "First",
          status: { name: "Open" },
          issuetype: { name: "Bug" },
          assignee: { displayName: "Alice" },
        },
      }),
    };
  }
  if (p === "/api/chat.postMessage") {
    slackPosts++;
    return { status: 200, body: JSON.stringify({ ok: true, channel: "C1", ts: "1760000000.000100" }) };
  }
  return { status: 404, body: "{}" };
}

beforeAll(async () => {
  vendor = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://vendor.test");
      if (url.pathname === "/rest/api/3/issue/PROJ-1") {
        activeIssueReads++;
        peakIssueReads = Math.max(peakIssueReads, activeIssueReads);
        if (issueDelayMs) await new Promise((resolve) => setTimeout(resolve, issueDelayMs));
        activeIssueReads--;
      }
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
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  stack = await setupGatewayStack(
    {
      GUILD_SELF_BASE_URL: `http://127.0.0.1:${port}`,
      GUILD_SANDBOX_ROOT: sandboxRoot,
      GUILD_DATA_DIR: dataDir,
      GUILD_ALLOW_SHELL_TOOLS: "1",
      GUILD_APPROVAL_TIMEOUT_MS: "3000",
      GUILD_CLIENT_TOOL_TIMEOUT_MS: "8000",
    },
    { dbPrefix: "guild_integrations_chat_test", logLevel: process.env.INTEGRATIONS_TEST_LOG ?? "error" },
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
    "INSERT INTO integrations (org_id, name, config, enabled, audience) VALUES ($1, 'atlassian', $2, true, 'org') ON CONFLICT (org_id, name) DO UPDATE SET config = EXCLUDED.config",
    [orgId, JSON.stringify({ site: vendorBase, email: "bot@example.test" })],
  );
  await stack.env.db.query(
    "INSERT INTO integration_secrets (org_id, integration, name, secret_enc) VALUES ($1, 'atlassian', 'token', $2) ON CONFLICT (org_id, integration, name) DO NOTHING",
    [orgId, encryptSecret(master, "atlassian-token")],
  );
  await stack.env.db.query(
    "INSERT INTO integrations (org_id, name, config, enabled, audience) VALUES ($1, 'slack', $2, true, 'org') ON CONFLICT (org_id, name) DO UPDATE SET config = EXCLUDED.config",
    [
      orgId,
      JSON.stringify({
        base_url: `${vendorBase}/api`,
        tools: {
          conversations_list: { enabled: true, approval: "always_ask" },
          post_message: { enabled: true, approval: "always_allow" },
        },
      }),
    ],
  );
  await stack.env.db.query(
    "INSERT INTO integration_secrets (org_id, integration, name, secret_enc) VALUES ($1, 'slack', 'bot_token', $2) ON CONFLICT (org_id, integration, name) DO NOTHING",
    [orgId, encryptSecret(master, "xoxb-1")],
  );
  await stack.env.db.query(
    "INSERT INTO integrations (org_id, name, config, enabled, audience) VALUES ($1, 'hubspot', $2, true, 'org')",
    [orgId, JSON.stringify({ base_url: vendorBase })],
  );
  await stack.env.db.query(
    "INSERT INTO integration_secrets (org_id, integration, name, secret_enc) VALUES ($1, 'hubspot', 'token', $2)",
    [orgId, encryptSecret(master, "test-hubspot-token")],
  );
  // A chat runs on its Member's personal Agent, which reaches no
  // Integration until someone adds it.
  await giveIntegrations(memberToken, [{ slug: "atlassian", ceiling: "read" }]);
  await giveIntegrations(stack.adminToken, [
    { slug: "slack", ceiling: "write" },
    { slug: "hubspot", ceiling: "write" },
  ]);
}, 60_000);

/** Sets the Integration list of the caller's personal Agent. */
async function giveIntegrations(token: string, entries: { slug: string; ceiling: string }[]): Promise<void> {
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  const list = await stack.env.app.inject({ method: "GET", url: "/api/v1/agents", headers });
  const personal = (JSON.parse(list.body) as { agents: { id: string; is_personal: boolean }[] }).agents.find(
    (agent) => agent.is_personal,
  )!;
  const res = await stack.env.app.inject({
    method: "PATCH",
    url: `/api/v1/agents/${personal.id}`,
    headers,
    payload: { integrations: entries },
  });
  if (res.statusCode !== 200) throw new Error(`integrations PATCH ${res.statusCode}: ${res.body}`);
}

afterAll(async () => {
  await stack.close();
  await new Promise<void>((resolve) => vendor.close(() => resolve()));
}, 30_000);

const auth = (token = memberToken): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

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
    "refuses a write when approval policy tightens after classification",
    async () => {
      const integration = (
        stack.env.app as unknown as { platform: { runtime: { integrationsRuntime: IntegrationsRuntime } } }
      ).platform.runtime.integrationsRuntime;
      const original = integration.gateDecision.bind(integration);
      const before = slackPosts;
      const spy = vi.spyOn(integration, "gateDecision").mockImplementation(async (...args) => {
        const result = await original(...args);
        if (args[1] === "slack_post_message")
          await stack.env.db.query(
            "UPDATE integrations SET config=jsonb_set(config,'{tools,post_message,approval}','\"always_ask\"') WHERE org_id=$1 AND name='slack'",
            [orgId],
          );
        return result;
      });
      try {
        const chatId = await createChat("changed-queued-approval", stack.adminToken);
        scriptFor(
          { body: toolCallSse("slack_post_message", JSON.stringify({ channel: "C1", text: "approval test" })) },
          { body: finalSse },
        );
        await submitTurn(chatId, "post this", stack.adminToken);
        await turnSettled(chatId, stack.adminToken);
        const result = toolResults(await threadEvents(chatId, stack.adminToken))[0]!.event as {
          is_error: boolean;
          content: string;
        };
        expect(result.is_error).toBe(true);
        expect(result.content).toContain("approval policy changed");
        expect(slackPosts).toBe(before);
      } finally {
        spy.mockRestore();
        await stack.env.db.query(
          "UPDATE integrations SET config=jsonb_set(config,'{tools,post_message,approval}','\"always_allow\"') WHERE org_id=$1 AND name='slack'",
          [orgId],
        );
      }
    },
    TEST_TIMEOUT,
  );

  it(
    "caps discovery and execution through a configured conversation's dynamic integration extension",
    async () => {
      const runtime = (
        stack.env.app as unknown as { platform: { runtime: { integrationsRuntime: IntegrationsRuntime } } }
      ).platform.runtime;
      const integration = runtime.integrationsRuntime;
      const original = integration.gateDecision.bind(integration);
      let activeDiscovery = 0;
      let peakDiscovery = 0;
      const spy = vi.spyOn(integration, "gateDecision").mockImplementation(async (...args) => {
        activeDiscovery++;
        peakDiscovery = Math.max(peakDiscovery, activeDiscovery);
        try {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return await original(...args);
        } finally {
          activeDiscovery--;
        }
      });
      const before = issueReads;
      issueDelayMs = 50;
      peakIssueReads = 0;
      try {
        const chatId = await createChat("configured-concurrency-cap");
        const code = `text(await Promise.all(Array.from({length:24}, () => tools.atlassian_jira_get_issue({issue_key:"PROJ-1"}))));`;
        scriptFor({ body: toolCallSse("codemode", JSON.stringify({ code })) }, { body: finalSse });
        await submitTurn(chatId, "read these issues together");
        await turnSettled(chatId);
        const result = toolResults(await threadEvents(chatId))[0]!.event as { is_error: boolean };
        expect(result.is_error).toBe(false);
        expect(issueReads - before).toBe(24);
        expect(spy).toHaveBeenCalledTimes(24);
        expect(peakDiscovery).toBeGreaterThan(1);
        expect(peakDiscovery).toBeLessThanOrEqual(8);
        expect(peakIssueReads).toBeGreaterThan(1);
        expect(peakIssueReads).toBeLessThanOrEqual(8);
      } finally {
        issueDelayMs = 0;
        spy.mockRestore();
      }
    },
    TEST_TIMEOUT,
  );

  it.each(["GET", "POST"])(
    "recognizes read operations behind the HubSpot API's write ceiling (%s)",
    async (method) => {
      const before = hubspotReads;
      const request =
        method === "GET"
          ? '{path: "/crm/v3/lists/" + id}'
          : '{method:"POST",path:"/crm/v3/objects/contacts/search",body:{query:String(id)}}';
      const chatId = await createChat("hubspot-read-static-check", stack.adminToken);
      const code = `for (const id of [1,2,3,4]) { const r=await tools.hubspot_api(${request}); text(r); }`;
      scriptFor({ body: toolCallSse("codemode", JSON.stringify({ code })) }, { body: finalSse });
      await submitTurn(chatId, "read these records", stack.adminToken);
      await turnSettled(chatId, stack.adminToken);
      const result = toolResults(await threadEvents(chatId, stack.adminToken))[0]!.event as {
        is_error: boolean;
        content: string;
      };
      expect(result.is_error).toBe(true);
      expect(result.content).toContain("Promise.all");
      expect(hubspotReads).toBe(before);
    },
    TEST_TIMEOUT,
  );

  it(
    "blocks independent read loops before any vendor call and accepts the parallel rewrite",
    async () => {
      const before = issueReads;
      const chatId = await createChat("independent-read-lint");
      const code = `text("sandbox started");
        for (const key of ["PROJ-1","PROJ-1","PROJ-1","PROJ-1"]) {
          const result = await tools.atlassian_jira_get_issue({issue_key:key});
          text(result);
        }`;
      scriptFor({ body: toolCallSse("codemode", JSON.stringify({ code })) }, { body: finalSse });
      await submitTurn(chatId, "read these issues");
      await turnSettled(chatId);
      const result = toolResults(await threadEvents(chatId))[0]!.event as { is_error: boolean; content: string };
      expect(result.is_error).toBe(true);
      expect(result.content).toContain("Promise.all");
      expect(result.content).not.toContain("sandbox started");
      expect(issueReads).toBe(before);

      const fixedChatId = await createChat("independent-read-parallel");
      const fixed = `const results = await Promise.all(["PROJ-1","PROJ-1","PROJ-1","PROJ-1"].map(
        (key) => tools.atlassian_jira_get_issue({issue_key:key})
      )); text(results);`;
      scriptFor({ body: toolCallSse("codemode", JSON.stringify({ code: fixed })) }, { body: finalSse });
      await submitTurn(fixedChatId, "read these issues together");
      await turnSettled(fixedChatId);
      const fixedResult = toolResults(await threadEvents(fixedChatId))[0]!.event as {
        is_error: boolean;
        content: string;
      };
      expect(fixedResult.is_error).toBe(false);
      expect(fixedResult.content).toContain("PROJ-1");
      expect(issueReads).toBe(before + 4);
    },
    TEST_TIMEOUT,
  );

  it(
    "registers list_tools + guide + connector tools; discovery returns the member-visible specs",
    async () => {
      const chatId = await createChat("m8-discovery");
      scriptFor({ body: toolCallSse("atlassian_list_tools", "{}") }, { body: finalSse });
      await submitTurn(chatId, "what atlassian tools do I have?");
      await turnSettled(chatId);

      const events = await threadEvents(chatId);
      const call = toolCalls(events).find((b) => (b as { name: string }).name === "codemode");
      expect(call).toBeDefined();
      const result = toolResults(events).find(
        (e) => (e.event as { call_id: string }).call_id === (call as { id: string }).id,
      );
      expect(result).toBeDefined();
      expect((result!.event as { is_error: boolean }).is_error).toBe(false);
      const specs = JSON.parse((result!.event as { content: string }).content.split("Output:\n")[1]!) as Record<
        string,
        unknown
      >[];
      const names = specs.map((s) => s["name"]);
      // Read-class connector tools within the personal Agent's read
      // ceiling; write-class tools (confluence_create_page, api) are out; the list_tools
      // JSON carries connector specs only (the guide auto is a registered
      // tool, not a spec).
      for (const expected of [
        "atlassian_jira_search",
        "atlassian_jira_get_issue",
        "atlassian_confluence_search",
        "atlassian_confluence_get_page",
      ]) {
        expect(names).toContain(expected);
      }
      expect(names).not.toContain("atlassian_confluence_create_page");
      expect(names).not.toContain("atlassian_api");
      // The spec shape: name, description, parameters — no rust kind field.
      const spec = specs.find((s) => s["name"] === "atlassian_jira_search")!;
      expect(typeof spec["description"]).toBe("string");
      expect((spec["parameters"] as Record<string, unknown>)["type"]).toBe("object");
      expect(spec["kind"]).toBeUndefined();

      // The integration's tools are one codemode namespace, headed by its slug.
      const system = (stack.mock.requests.at(-1)!.body["messages"] as { role: string; content: unknown }[])
        .filter((m) => m.role === "system")
        .map((m) => String(m.content))
        .join("\n");
      expect(system).toMatch(/^## atlassian( \(some tools not listed\))?$/m);
      // The connector's own tools are deferred: the section lists only the
      // discovery tools, and the rest arrive through list_tools.
      expect(system).not.toContain("atlassian_jira_search");
      // The manifest names no skill, so the Turn has no guide tool.
      expect(system).not.toContain("atlassian_guide");

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
      const result = toolResults(events).find(
        (e) => (e.event as { call_id: string }).call_id === (call as { id: string }).id,
      );
      expect(result).toBeDefined();
      expect((result!.event as { is_error: boolean }).is_error).toBe(false);
      expect((result!.event as { content: string }).content).toContain("1760000000.000100");
    },
    TEST_TIMEOUT,
  );
});
