// The integrations chat runtime: the connector execute paths against a
// local mock backend (no external API calls — ever), the MCP tool call
// against a stub MCP peer, and the chat-loop registration flow (per-turn
// tool registration, discovery, execution, audit, and the always_ask
// approval card) against the real app + harness + mock provider.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NO_REGISTRY } from "./support/no-registry.js";
import { executeConnectorTool, callPlugin } from "../integrations/execute.js";
import { mcpConnect } from "../integrations/mcp.js";

// ---------- the mock vendor backend ----------

/** One captured request: method, path, query, headers, and (for POSTs) the
 *  JSON body — the assertions read these instead of calling out. */
interface Hit {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: string;
}

const hits: Hit[] = [];

function route(req: IncomingMessage, url: URL, body: string): { status: number; body: string } {
  hits.push({
    method: req.method ?? "GET",
    path: url.pathname,
    query: url.searchParams,
    headers: Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v ?? "")]),
    ),
    body,
  });
  const p = url.pathname;
  // Google OAuth token endpoint: the JWT assertion rides the form body.
  if (p === "/token") {
    return { status: 200, body: JSON.stringify({ access_token: "tok-1", expires_in: 3600 }) };
  }
  // Gmail search.
  if (p === "/gmail/v1/users/me/messages" && url.searchParams.has("q")) {
    return {
      status: 200,
      body: JSON.stringify({
        messages: [
          { id: "msg-1", threadId: "th-1" },
          { id: "msg-2", threadId: "th-2" },
        ],
        resultSizeEstimate: 2,
      }),
    };
  }
  // Gmail message with a base64url text body ("Hello") + an attachment part.
  if (p === "/gmail/v1/users/me/messages/msg-1") {
    return {
      status: 200,
      body: JSON.stringify({
        payload: {
          headers: [
            { name: "Subject", value: "Quarterly report" },
            { name: "From", value: "alice@example.test" },
          ],
          parts: [
            { mimeType: "text/plain", body: { data: "SGVsbG8", attachmentId: "" } },
            { filename: "data.bin", mimeType: "image/jpeg", body: { attachmentId: "att-1" } },
          ],
        },
        snippet: "Hello",
      }),
    };
  }
  // Gmail attachment: JPEG magic bytes, url-safe base64url without padding.
  if (p === "/gmail/v1/users/me/messages/msg-1/attachments/att-1") {
    return { status: 200, body: JSON.stringify({ size: 4, data: "_9j_4A" }) };
  }
  // Calendar.
  if (p === "/calendar/v3/calendars/primary/events") {
    return {
      status: 200,
      body: JSON.stringify({ items: [{ start: { dateTime: "2026-10-05T09:00:00Z" }, summary: "Standup" }] }),
    };
  }
  // Drive.
  if (p === "/drive/v3/files") {
    return {
      status: 200,
      body: JSON.stringify({ files: [{ id: "f-1", name: "report", mimeType: "application/pdf" }] }),
    };
  }
  // Directory.
  if (p === "/admin/directory/v1/users") {
    return {
      status: 200,
      body: JSON.stringify({ users: [{ primaryEmail: "bob@example.test", name: { fullName: "Bob Bobson" } }] }),
    };
  }
  // Generic api tool target.
  if (p === "/gapi/thing") {
    return { status: 200, body: JSON.stringify({ done: true }) };
  }
  // Jira search.
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
          {
            key: "PROJ-2",
            fields: { summary: "Second", status: { name: "Done" }, issuetype: { name: "Task" }, assignee: null },
          },
        ],
      }),
    };
  }
  // Jira issue.
  if (p === "/rest/api/3/issue/PROJ-1") {
    return {
      status: 200,
      body: JSON.stringify({
        key: "PROJ-1",
        fields: {
          summary: "First",
          status: { name: "Open" },
          issuetype: { name: "Bug" },
          assignee: { displayName: "Alice" },
          created: "2026-10-01T10:00:00.000+0000",
        },
      }),
    };
  }
  // Confluence search.
  if (p === "/wiki/rest/api/search") {
    return {
      status: 200,
      body: JSON.stringify({
        results: [{ content: { title: "Runbook", id: "7" }, excerpt: "how to operate" }],
      }),
    };
  }
  // Confluence page.
  if (p === "/wiki/rest/api/content/7") {
    return {
      status: 200,
      body: JSON.stringify({
        id: "7",
        title: "Runbook",
        body: { storage: { value: "<p>step one</p><p>step two</p>" } },
        _links: { webui: "/spaces/PROJ/pages/7/Runbook" },
      }),
    };
  }
  // Confluence create.
  if (p === "/wiki/rest/api/content" && req.method === "POST") {
    return {
      status: 200,
      body: JSON.stringify({ id: "9", title: "New page", _links: { webui: "/spaces/PROJ/pages/9" } }),
    };
  }
  // Slack.
  if (p === "/api/chat.postMessage") {
    return { status: 200, body: JSON.stringify({ ok: true, channel: "C1", ts: "1760000000.000100" }) };
  }
  if (p === "/api/conversations.list") {
    return {
      status: 200,
      body: JSON.stringify({
        ok: true,
        channels: [{ id: "C1", name: "general", is_private: false, is_member: true, topic: { value: "everything" } }],
        response_metadata: { next_cursor: "cur-1" },
      }),
    };
  }
  // GitHub.
  if (p === "/repos/o/r/issues") {
    return {
      status: 200,
      body: JSON.stringify([
        { number: 1, title: "Real issue", state: "open", user: { login: "alice" } },
        { number: 2, title: "A pull", state: "open", user: { login: "bob" }, pull_request: { html_url: "x" } },
      ]),
    };
  }
  // GitLab.
  if (p.endsWith("/projects/o%2Fr/issues") || p.endsWith("/projects/o/r/issues")) {
    return {
      status: 200,
      body: JSON.stringify([{ iid: 5, title: "Issue", state: "opened", author: { username: "alice" } }]),
    };
  }
  // HubSpot.
  if (p === "/crm/v3/objects/contacts/search") {
    return {
      status: 200,
      body: JSON.stringify({
        results: [{ id: "101", properties: { firstname: "Ann", lastname: "Lee", email: "ann@x.test" } }],
      }),
    };
  }
  // Langfuse.
  if (p === "/api/public/traces") {
    return {
      status: 200,
      body: JSON.stringify({ data: [{ id: "t-1", name: "chat", timestamp: "2026-10-05T09:00:00Z" }] }),
    };
  }
  // Firecrawl.
  if (p === "/v1/scrape") {
    return {
      status: 200,
      body: JSON.stringify({
        success: true,
        data: { markdown: "# page", metadata: { sourceURL: "https://x.test", statusCode: 200, title: "X" } },
      }),
    };
  }
  if (p === "/v1/search") {
    return {
      status: 200,
      body: JSON.stringify({ success: true, data: [{ title: "Res", url: "https://x.test/a", description: "snip" }] }),
    };
  }
  // SearxNG.
  if (p === "/search") {
    return {
      status: 200,
      body: JSON.stringify({ results: [{ title: "Res", url: "https://x.test/a", content: "snip" }] }),
    };
  }
  // A status-based failure path.
  if (p === "/rest/api/3/issue/BROKEN-1") {
    return { status: 400, body: JSON.stringify({ errors: { jql: "bad" } }) };
  }
  return { status: 404, body: "{}" };
}

let vendor: Server;
let vendorBase = "";

beforeAll(async () => {
  vendor = createServer((req: IncomingMessage, res: ServerResponse) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://vendor.test");
      const out = route(req, url, body);
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(out.body);
    });
  });
  await new Promise<void>((resolve) => vendor.listen(0, "127.0.0.1", resolve));
  vendorBase = `http://127.0.0.1:${(vendor.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => vendor.close(() => resolve()));
});

// The test service account: a real RSA key so the RS256 JWT exchange runs
// for real; the token endpoint is the mock.
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccountJson = JSON.stringify({
  client_email: "bot@test-iam.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});
const googleConfig = () => ({
  api_base: vendorBase,
  token_url: `${vendorBase}/token`,
  admin_email: "admin@example.test",
});
const GOOGLE_SECRETS: [string, string][] = [["service_account_json", serviceAccountJson]];

function lastHit(path: string): Hit {
  const found = [...hits].reverse().find((h) => h.path === path);
  if (found === undefined) throw new Error(`no hit for ${path}`);
  return found;
}

/** Decodes a JWT payload section without verifying (the key pair is the
 *  test's own; the signing itself is exercised by the token endpoint). */
function jwtPayload(assertion: string): Record<string, unknown> {
  const part = assertion.split(".")[1]!;
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<string, unknown>;
}

// ---------- google_workspace execute ----------

describe("google_workspace execute (mock backend)", () => {
  it("gmail_search mints a token with the admin sub and renders the result list", async () => {
    const out = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "google_workspace",
      googleConfig(),
      "gmail_search",
      { query: "from:alice" },
      GOOGLE_SECRETS,
      null,
    );
    expect(out.content).toContain('Gmail search "from:alice": 2 result(s)');
    expect(out.content).toContain("- id msg-1 (thread th-1)");
    const tokenHit = lastHit("/token");
    expect(tokenHit.body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
    const assertion = new URLSearchParams(tokenHit.body).get("assertion")!;
    expect(jwtPayload(assertion)["sub"]).toBe("admin@example.test");
    expect(jwtPayload(assertion)["scope"]).toContain("gmail.readonly");
    const searchHit = lastHit("/gmail/v1/users/me/messages");
    expect(searchHit.headers["authorization"]).toBe("Bearer tok-1");
    expect(searchHit.query.get("q")).toBe("from:alice");
  });

  it("an acting identity rides the token sub claim (google impersonation)", async () => {
    await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "google_workspace",
      googleConfig(),
      "gmail_search",
      { query: "x" },
      GOOGLE_SECRETS,
      "member@example.test",
    );
    const assertion = new URLSearchParams(lastHit("/token").body).get("assertion")!;
    expect(jwtPayload(assertion)["sub"]).toBe("member@example.test");
  });

  it("gmail_get_message renders headers, the decoded text body, and the attachment list", async () => {
    const out = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "google_workspace",
      googleConfig(),
      "gmail_get_message",
      { message_id: "msg-1" },
      GOOGLE_SECRETS,
      null,
    );
    expect(out.content).toContain("Subject: Quarterly report");
    expect(out.content).toContain("From: alice@example.test");
    expect(out.content).toContain("Hello");
    expect(out.content).toContain("- data.bin (image/jpeg; attachment id att-1)");
  });

  it("gmail_get_attachment decodes the base64url body into a binary artifact", async () => {
    const out = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "google_workspace",
      googleConfig(),
      "gmail_get_attachment",
      { message_id: "msg-1", attachment_id: "att-1" },
      GOOGLE_SECRETS,
      null,
    );
    expect(out.content).toBe("attachment data.bin (4 bytes, image/jpeg)");
    expect(out.artifact).toBeDefined();
    expect([...out.artifact!.bytes]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
    expect(out.artifact!.contentType).toBe("image/jpeg");
  });

  it("calendar, drive, directory, and the api tool reach their endpoints", async () => {
    const calendar = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "google_workspace",
      googleConfig(),
      "calendar_list_events",
      {},
      GOOGLE_SECRETS,
      null,
    );
    expect(calendar.content).toContain("Standup");
    const drive = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "google_workspace",
      googleConfig(),
      "drive_search",
      { name: "report" },
      GOOGLE_SECRETS,
      null,
    );
    expect(drive.content).toContain("report — application/pdf (id f-1)");
    const directory = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "google_workspace",
      googleConfig(),
      "directory_users",
      {},
      GOOGLE_SECRETS,
      null,
    );
    // Default domain: the admin_email's own.
    expect(lastHit("/admin/directory/v1/users").query.get("domain")).toBe("example.test");
    expect(directory.content).toContain("Bob Bobson");
    const api = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "google_workspace",
      googleConfig(),
      "api",
      { path: "/gapi/thing" },
      GOOGLE_SECRETS,
      null,
    );
    expect(api.content).toContain('"done":true');
    expect(lastHit("/gapi/thing").headers["authorization"]).toBe("Bearer tok-1");
    expect(api.meta).toMatchObject({ card: "api", status: 200 });
  });

  it("an unknown tool fails without touching the network", async () => {
    const before = hits.length;
    await expect(
      executeConnectorTool(
        NO_REGISTRY,
        "org-test",
        "google_workspace",
        googleConfig(),
        "nope",
        {},
        GOOGLE_SECRETS,
        null,
      ),
    ).rejects.toThrow("google_workspace integration has no tool nope");
    expect(hits.length).toBe(before);
  });
});

// ---------- atlassian execute ----------

const atlassianConfig = () => ({ site: vendorBase, email: "bot@example.test" });
const ATLASSIAN_SECRETS: [string, string][] = [["token", "atlassian-token"]];

function atlassianAuthOf(hit: Hit): string {
  return Buffer.from(hit.headers["authorization"].replace("Basic ", ""), "base64").toString("utf8");
}

describe("atlassian execute (mock backend)", () => {
  it("jira_search posts the JQL body and renders the issue lines with meta", async () => {
    const out = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "atlassian",
      atlassianConfig(),
      "jira_search",
      { jql: "project = PROJ", max_results: 1 },
      ATLASSIAN_SECRETS,
      null,
    );
    expect(atlassianAuthOf(lastHit("/rest/api/3/search/jql"))).toBe("bot@example.test:atlassian-token");
    expect(JSON.parse(lastHit("/rest/api/3/search/jql").body)).toMatchObject({ jql: "project = PROJ", maxResults: 1 });
    expect(out.content).toBe("PROJ-1 — First [Open] (Alice)");
    expect(out.meta).toMatchObject({ kind: "jira_search", count: 1, truncated: true });
  });

  it("jira_get_issue flattens the issue with the browse URL", async () => {
    const out = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "atlassian",
      atlassianConfig(),
      "jira_get_issue",
      { issue_key: "PROJ-1" },
      ATLASSIAN_SECRETS,
      null,
    );
    expect(out.content).toContain("PROJ-1 — First");
    expect(out.content).toContain("type: Bug | status: Open | assignee: Alice");
    expect(out.content).toContain(`${vendorBase}/browse/PROJ-1`);
    expect(out.meta).toMatchObject({ kind: "jira_issue", key: "PROJ-1" });
  });

  it("confluence_search and confluence_get_page render CQL results and storage text", async () => {
    const search = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "atlassian",
      atlassianConfig(),
      "confluence_search",
      { cql: "space = PROJ" },
      ATLASSIAN_SECRETS,
      null,
    );
    expect(search.content).toBe("Runbook (id 7): how to operate");
    expect(search.meta).toMatchObject({ kind: "confluence_search", count: 1 });
    const page = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "atlassian",
      atlassianConfig(),
      "confluence_get_page",
      { page_id: "7" },
      ATLASSIAN_SECRETS,
      null,
    );
    expect(page.content).toContain("Runbook");
    expect(page.content).toContain("step one step two");
    expect(page.content).toContain(`${vendorBase}/spaces/PROJ/pages/7/Runbook`);
    expect(lastHit("/wiki/rest/api/content/7").query.get("expand")).toBe("body.storage");
  });

  it("confluence_create_page posts the storage body and renders the created page", async () => {
    const out = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "atlassian",
      atlassianConfig(),
      "confluence_create_page",
      { space_key: "PROJ", title: "New page", content: "<p>hello</p>" },
      ATLASSIAN_SECRETS,
      null,
    );
    expect(JSON.parse(lastHit("/wiki/rest/api/content").body)).toMatchObject({
      type: "page",
      title: "New page",
      space: { key: "PROJ" },
      body: { storage: { value: "<p>hello</p>", representation: "storage" } },
    });
    expect(out.content).toContain("Created page 9 (New page)");
    expect(out.content).toContain(`${vendorBase}/spaces/PROJ/pages/9`);
    expect(out.meta).toMatchObject({
      kind: "confluence_page_created",
      id: "9",
      url: `${vendorBase}/spaces/PROJ/pages/9`,
    });
  });

  it("the api tool rides basic auth and truncates per the cap", async () => {
    const out = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "atlassian",
      atlassianConfig(),
      "api",
      { path: "/gapi/thing" },
      ATLASSIAN_SECRETS,
      null,
    );
    expect(atlassianAuthOf(lastHit("/gapi/thing"))).toBe("bot@example.test:atlassian-token");
    expect(out.content).toContain('"done":true');
    expect(out.meta).toMatchObject({ card: "api", status: 200 });
  });

  it("a vendor 400 surfaces as the tool-error contract with the body excerpt", async () => {
    await expect(
      executeConnectorTool(
        NO_REGISTRY,
        "org-test",
        "atlassian",
        atlassianConfig(),
        "jira_get_issue",
        { issue_key: "BROKEN-1" },
        ATLASSIAN_SECRETS,
        null,
      ),
    ).rejects.toThrow(/^atlassian returned 400: /);
  });

  it("a dot-segment path is rejected (path traversal guard)", async () => {
    await expect(
      executeConnectorTool(
        NO_REGISTRY,
        "org-test",
        "atlassian",
        atlassianConfig(),
        "jira_get_issue",
        { issue_key: ".." },
        ATLASSIAN_SECRETS,
        null,
      ),
    ).rejects.toThrow('path segment ".." is not allowed');
  });
});

// ---------- the other connectors (spot checks) ----------

describe("connector execute spot checks (mock backend)", () => {
  it("slack post_message posts through chat.postMessage and tolerates the ok envelope", async () => {
    const out = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "slack",
      { base_url: `${vendorBase}/api` },
      "post_message",
      { channel: "C1", text: "hi" },
      [["bot_token", "xoxb-1"]],
      null,
    );
    expect(lastHit("/api/chat.postMessage").headers["authorization"]).toBe("Bearer xoxb-1");
    expect(JSON.parse(lastHit("/api/chat.postMessage").body)).toEqual({ channel: "C1", text: "hi" });
    expect(JSON.parse(out.content)).toMatchObject({ channel: "C1", ts: "1760000000.000100" });
  });

  it("github list_issues skips pull requests", async () => {
    const out = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "github",
      { api_url: vendorBase },
      "list_issues",
      { owner: "o", repo: "r" },
      [["token", "gh-1"]],
      null,
    );
    expect(lastHit("/repos/o/r/issues").headers["user-agent"]).toBe("guild-integration-github");
    expect(out.content).toContain("#1 [open] Real issue (@alice)");
    expect(out.content).not.toContain("A pull");
  });

  it("gitlab list_issues renders the mr-style lines", async () => {
    console.log(
      "DEBUG-GITLAB-PATHS",
      hits.filter((h) => h.path.includes("projects")).map((h) => h.path),
    );
    const out = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "gitlab",
      { base_url: vendorBase },
      "list_issues",
      { project: "o/r" },
      [["token", "gl-1"]],
      null,
    );
    expect(lastHit("/api/v4/projects/o%2Fr/issues").headers["private-token"]).toBe("gl-1");
    expect(out.content).toContain("!5 [opened] Issue (@alice)");
  });

  it("hubspot search rides the bearer token and renders the crm card meta", async () => {
    const out = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "hubspot",
      { base_url: vendorBase },
      "search_contacts",
      { query: "ann" },
      [["token", "hs-1"]],
      null,
    );
    expect(lastHit("/crm/v3/objects/contacts/search").headers["authorization"]).toBe("Bearer hs-1");
    expect(out.content).toContain("id=101");
    expect(out.meta).toMatchObject({ card: "crm", kind: "search", object: "contacts", count: 1 });
  });

  it("langfuse list_traces uses the basic auth pair", async () => {
    const out = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "langfuse",
      { base_url: vendorBase },
      "list_traces",
      { limit: 1 },
      [
        ["public_key", "pk"],
        ["secret_key", "sk"],
      ],
      null,
    );
    expect(lastHit("/api/public/traces").headers["authorization"]).toBe(
      `Basic ${Buffer.from("pk:sk").toString("base64")}`,
    );
    expect(out.content).toContain("1. t-1 chat");
    expect(out.meta).toMatchObject({ card: "langfuse", kind: "traces", count: 1 });
  });

  it("firecrawl web_fetch renders the markdown with the web card meta", async () => {
    const out = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "firecrawl",
      { base_url: vendorBase },
      "web_fetch",
      { url: "https://x.test" },
      [],
      null,
    );
    expect(out.content).toContain("# page");
    expect(out.meta).toMatchObject({ card: "web", kind: "fetch", url: "https://x.test", status_code: 200 });
  });

  it("firecrawl web_search maps count onto the firecrawl limit", async () => {
    const out = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "firecrawl",
      { base_url: vendorBase },
      "web_search",
      { query: "x", count: 5 },
      [],
      null,
    );
    expect(lastHit("/v1/search").body).toContain('"limit":5');
    expect(out.content).toContain("1. Res");
    expect(out.meta).toMatchObject({ card: "web", kind: "search", truncated: false });
  });

  it("searxng web_search renders numbered results with source meta", async () => {
    const out = await executeConnectorTool(
      NO_REGISTRY,
      "org-test",
      "searxng",
      { base_url: vendorBase },
      "web_search",
      { query: "x", count: 5 },
      [],
      null,
    );
    expect(lastHit("/search").query.get("q")).toBe("x");
    expect(out.content).toContain("1. Res");
    expect(out.meta).toMatchObject({ card: "web", kind: "search", truncated: false });
  });
});

// ---------- MCP tool call (stub peer) ----------

import type { IntegrationCallIdentity } from "../integrations/execute.js";
import type { PluginSecretSource, IntegrationTurn } from "../integrations/plugins.js";
import type { JsonObject } from "../integrations/shared.js";
import type { IntegrationToolSpec } from "../integrations/loader.js";

describe("MCP tools/call (stub peer)", () => {
  let mcp: Server;
  let mcpUrl = "";
  const seen: { headers: Record<string, string>; methods: string[]; calls: { tool: string; args: unknown }[] } = {
    headers: {},
    methods: [],
    calls: [],
  };

  beforeAll(async () => {
    mcp = createServer((req, res) => {
      let body = "";
      req.on("data", (c: Buffer) => (body += c));
      req.on("end", () => {
        const msg = JSON.parse(body) as { id: number; method: string; params?: JsonObject };
        seen.headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
        seen.methods.push(msg.method);
        const reply = (result: unknown): void => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
        };
        if (msg.method === "initialize") {
          reply({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "stub", version: "0" } });
          return;
        }
        if (msg.method === "tools/call") {
          const args = (msg.params ?? {}) as { name?: string; arguments?: unknown };
          seen.calls.push({ tool: args.name ?? "", args: args.arguments });
          if (args.name === "fail_tool") {
            reply({ content: [{ type: "text", text: "boom" }], isError: true });
            return;
          }
          if (args.name === "multi") {
            reply({
              content: [
                { type: "text", text: "line one" },
                { type: "text", text: "line two" },
              ],
              isError: false,
            });
            return;
          }
          reply({ content: [{ type: "text", text: `echo:${JSON.stringify(args.arguments ?? {})}` }], isError: false });
          return;
        }
        reply({});
      });
    });
    await new Promise<void>((resolve) => mcp.listen(0, "127.0.0.1", resolve));
    mcpUrl = `http://127.0.0.1:${(mcp.address() as AddressInfo).port}/mcp`;
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => mcp.close(() => resolve()));
  });

  it("calls a tool through the streamable-HTTP transport and joins the text blocks", async () => {
    const peer = await mcpConnect(mcpUrl, { "x-guild-org": "org-1" });
    const result = await peer.callTool("multi", {});
    expect(result).toEqual({ content: "line one\nline two", isError: false });
    expect(seen.methods.slice(0, 3)).toEqual(["initialize", "notifications/initialized", "tools/call"]);
  });

  it("rides the identity envelope and secret headers onto the transport", async () => {
    const peer = await mcpConnect(mcpUrl, {
      "x-guild-org": "org-1",
      "x-guild-caller": "caller-1",
      "x-guild-acting-as": "member@example.test",
      "x-guild-secret-api_key": "sekret",
    });
    await peer.callTool("echo", { text: "hi" });
    expect(seen.headers["x-guild-org"]).toBe("org-1");
    expect(seen.headers["x-guild-acting-as"]).toBe("member@example.test");
    expect(seen.headers["x-guild-secret-api_key"]).toBe("sekret");
    expect(seen.calls.at(-1)).toEqual({ tool: "echo", args: { text: "hi" } });
  });

  it("maps isError to the result contract, never a thrown transport error", async () => {
    const peer = await mcpConnect(mcpUrl, {});
    const result = await peer.callTool("fail_tool", {});
    expect(result.isError).toBe(true);
    expect(result.content).toBe("boom");
  });

  it("callPlugin dispatches the MCP turn with re-resolved secrets and the call identity", async () => {
    const resolved: string[][] = [];
    const source: PluginSecretSource = {
      integrationSecrets: {
        names: async () => ["api_key"],
        resolve: async (_org, _slug, names) => {
          resolved.push(names);
          return [["api_key", "sekret"]];
        },
      },
      masterKey: () => Buffer.alloc(32, 7),
    };
    const spec = {
      name: "echo",
      description: "Echo",
      input_schema: { type: "object" },
    } as unknown as IntegrationToolSpec;
    const turn: IntegrationTurn = {
      executor: "mcp",
      slug: "test-mcp",
      description: "test",
      tools: [{ spec, class: "read", raw: "echo" }],
      rowConfig: { mcp: { url: mcpUrl } },
      secretNames: ["api_key"],
      identityKey: "test-mcp",
    };
    const identity: IntegrationCallIdentity = {
      orgId: "org-1",
      callerId: "caller-1",
      callId: "call-1",
      actingAs: "member@example.test",
    };
    const out = await callPlugin({ ...source, ...NO_REGISTRY }, turn, "echo", { text: "hi" }, identity);
    expect(out.content).toBe('echo:{"text":"hi"}');
    expect(out.meta).toBeUndefined();
    // Secrets were re-resolved at call time (snapshots never carry values).
    expect(resolved).toEqual([["api_key"]]);
    expect(seen.headers["x-guild-caller"]).toBe("caller-1");
    expect(seen.headers["x-guild-call-id"]).toBe("call-1");
  });
});
