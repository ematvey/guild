// Built-in connector tool catalogs (crates/server/src/integrations.rs and
// integrations/*.rs): tool declarations with their manifest classes, config
// validation, and connection tests. The runtime (execute) is not ported —
// spec decision 8 defers the integrations runtime, so a validated execute
// call fails the way the Rust connector fails with its backend unreachable
// (see src/platform/http/integration_tools.ts).

import { createSign } from "node:crypto";

export interface ConnectorToolSpec {
  name: string;
  description: string;
  /** JSON Schema object. */
  parameters: unknown;
}

export interface BuiltinConnector {
  name: string;
  /** In-code manifest tool classes (the policy floor; undeclared = read). */
  classes: Record<string, string>;
  /** Validates the row config (throws on a broken one) and declares the
   *  tool surface the connector contributes. */
  tools(config: Record<string, unknown>): ConnectorToolSpec[];
  /** The save gate's connection test against the would-be state; throws
   *  with the Rust connector's error text on failure. */
  testConnection(config: Record<string, unknown>, secrets: [string, string][]): Promise<void>;
}

type Json = Record<string, unknown>;

const PROBE_TIMEOUT_MS = 15_000;

/** crates/server/src/integrations.rs probe(): any 2xx passes; a transport
 *  failure or a non-2xx status fails with the connector's error text. */
async function probe(req: Promise<Response>, what: string): Promise<void> {
  let res: Response;
  try {
    res = await req;
  } catch (error) {
    const cause = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
    throw new Error(`${what} unreachable: ${cause}`);
  }
  if (!res.ok) {
    throw new Error(`${what} rejected the connection (${res.status} ${res.statusText})`);
  }
}

function fetchTimeout(init?: RequestInit): RequestInit {
  return { ...init, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) };
}

function secret(secrets: [string, string][], name: string): string {
  const found = secrets.find(([n]) => n === name);
  if (found === undefined) throw new Error(`secret ${name} is not stored`);
  return found[1];
}

function secretOrNull(secrets: [string, string][], name: string): string | null {
  const found = secrets.find(([n]) => n === name);
  return found === undefined ? null : found[1];
}

function configString(config: Json, name: string): string | undefined {
  const v = config[name];
  return typeof v === "string" ? v : undefined;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** The generic `api` tool every REST-connector exposes (api_tool_spec). */
function apiToolSpec(vendor: string): ConnectorToolSpec {
  return {
    name: "api",
    description:
      `Call any ${vendor} REST endpoint directly — the full API surface ` +
      "beyond the named tools. Args: method (GET/POST/PATCH/PUT/DELETE, " +
      "default GET), path (starts with /), query (object of strings), " +
      "body (JSON object). Use the named tools for simple lookups; use " +
      "this for filters, associations, batch operations, and anything " +
      "else the API supports.",
    parameters: {
      type: "object",
      properties: {
        method: { type: "string", description: "HTTP method, default GET" },
        path: { type: "string", description: "Endpoint path starting with /" },
        query: { type: "object", description: "Query parameters as strings" },
        body: { type: "object", description: "JSON request body (POST/PATCH/PUT)" },
      },
      required: ["path"],
    },
  };
}

const GOOGLE_SCOPES =
  "https://www.googleapis.com/auth/gmail.readonly " +
  "https://www.googleapis.com/auth/calendar.readonly " +
  "https://www.googleapis.com/auth/drive.readonly " +
  "https://www.googleapis.com/auth/admin.directory.user.readonly";
const FIRECRAWL_BASE_URL = "http://host.docker.internal:3002";

function githubApiUrl(config: Json): string {
  return trimTrailingSlash(configString(config, "api_url") ?? "https://api.github.com");
}

function gitlabBaseUrl(config: Json): string {
  return trimTrailingSlash(configString(config, "base_url") ?? "https://gitlab.com/api/v4");
}

function hubspotBaseUrl(config: Json): string {
  return trimTrailingSlash(configString(config, "base_url") ?? "https://api.hubapi.com");
}

function langfuseBaseUrl(config: Json, secrets: [string, string][]): string {
  // The config base_url wins; the legacy `host` secret of pre-schema
  // deployments is the fallback; else the public cloud.
  const fromConfig = configString(config, "base_url");
  if (fromConfig !== undefined) return trimTrailingSlash(fromConfig);
  const host = secretOrNull(secrets, "host");
  if (host !== null) return trimTrailingSlash(host);
  return "https://cloud.langfuse.com";
}

function slackBaseUrl(config: Json): string {
  return trimTrailingSlash(configString(config, "base_url") ?? "https://slack.com/api");
}

function firecrawlBaseUrl(config: Json): string {
  return trimTrailingSlash(configString(config, "base_url") ?? FIRECRAWL_BASE_URL);
}

/** RS256 JWT → access token for the default subject (the admin_email
 *  setting): the save gate proves the service account can mint a token. */
async function googleAccessToken(config: Json, secrets: [string, string][]): Promise<void> {
  const raw = secret(secrets, "service_account_json");
  let parsed: Json;
  try {
    parsed = JSON.parse(raw) as Json;
  } catch (error) {
    throw new Error(`service_account_json is not valid json: ${(error as Error).message}`);
  }
  const clientEmail = parsed["client_email"];
  if (typeof clientEmail !== "string") throw new Error("service_account_json missing client_email");
  const privateKey = parsed["private_key"];
  if (typeof privateKey !== "string") throw new Error("service_account_json missing private_key");
  const tokenUrl =
    trimTrailingSlash(configString(config, "token_url") ?? "https://oauth2.googleapis.com/token") ||
    "https://oauth2.googleapis.com/token";
  const adminEmail = configString(config, "admin_email") ?? secretOrNull(secrets, "admin_email");
  if (adminEmail === null) throw new Error("secret admin_email is not stored");
  const now = Math.floor(Date.now() / 1000);
  const b64url = (input: Buffer | string): string =>
    Buffer.from(input).toString("base64url");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({
      iss: clientEmail,
      sub: adminEmail,
      scope: GOOGLE_SCOPES,
      aud: tokenUrl,
      iat: now,
      exp: now + 3600,
    }),
  );
  let assertion: string;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    assertion = `${header}.${claims}.${signer.sign(privateKey).toString("base64url")}`;
  } catch (error) {
    throw new Error(`service account jwt signing failed: ${(error as Error).message}`);
  }
  let res: Response;
  try {
    res = await fetch(tokenUrl, fetchTimeout({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    }));
  } catch (error) {
    const cause = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
    throw new Error(`google token endpoint unreachable: ${cause}`);
  }
  if (!res.ok) throw new Error(`google token endpoint returned ${res.status}`);
  let body: Json;
  try {
    body = (await res.json()) as Json;
  } catch (error) {
    throw new Error(`google token endpoint returned bad json: ${(error as Error).message}`);
  }
  if (typeof body["access_token"] !== "string") {
    throw new Error("google token response missing access_token");
  }
}

export const BUILTIN_CONNECTORS: BuiltinConnector[] = [
  {
    name: "searxng",
    classes: { web_search: "read" },
    tools(config: Json) {
      const base = configString(config, "base_url");
      if (base === undefined) throw new Error("searxng config requires base_url");
      void trimTrailingSlash(base);
      return [{
        name: "web_search",
        description: "Search the web and return the top results (title, url, snippet).",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            count: { type: "number", description: "1-10, default 5" },
          },
          required: ["query"],
        },
      }];
    },
    async testConnection(config: Json) {
      const base = configString(config, "base_url");
      if (base === undefined) throw new Error("searxng config requires base_url");
      const url = new URL(`${trimTrailingSlash(base)}/search`);
      url.searchParams.set("q", "guild");
      url.searchParams.set("format", "json");
      await probe(fetch(url, fetchTimeout()), "searxng");
    },
  },
  {
    name: "superproxy",
    classes: { web_fetch: "read" },
    tools(config: Json) {
      const base = configString(config, "base_url");
      if (base === undefined) throw new Error("superproxy config requires base_url");
      void trimTrailingSlash(base);
      return [{
        name: "web_fetch",
        description:
          "Fetch a web page through the superproxy gateway and return its " +
          "content as markdown (title, description, main text).",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Absolute http(s) URL to fetch" },
            max_chars: {
              type: "number",
              description: "Max characters of returned content (default 8000)",
            },
          },
          required: ["url"],
        },
      }];
    },
    async testConnection(config: Json, secrets) {
      const base = configString(config, "base_url");
      if (base === undefined) throw new Error("superproxy config requires base_url");
      const url = new URL(`${trimTrailingSlash(base)}/v1/fetch`);
      url.searchParams.set("url", "https://example.com");
      url.searchParams.set("format", "markdown");
      // The stored token secret wins; the config token is the legacy
      // fallback.
      const token = secretOrNull(secrets, "token") ?? configString(config, "token");
      const headers: Record<string, string> = {};
      if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
      await probe(fetch(url, fetchTimeout({ headers })), "superproxy");
    },
  },
  {
    name: "firecrawl",
    classes: { scrape: "read", search: "read", map: "read" },
    tools() {
      return [
        {
          name: "scrape",
          description: "Fetch a web page through the Firecrawl API and return its content as markdown.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "Absolute http(s) URL to scrape" },
              max_chars: {
                type: "number",
                description: "Max characters of returned markdown (default 8000)",
              },
            },
            required: ["url"],
          },
        },
        {
          name: "search",
          description: "Search the web through the Firecrawl API and return the top results (title, url, description).",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              limit: { type: "number", description: "1-20, default 5" },
              scrape: {
                type: "boolean",
                description: "Also scrape each result and return a short markdown excerpt (slower)",
              },
            },
            required: ["query"],
          },
        },
        {
          name: "map",
          description: "List the links Firecrawl discovers on one site (sitemap style crawl).",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "Absolute http(s) URL of the site root" },
            },
            required: ["url"],
          },
        },
      ];
    },
    async testConnection(config: Json, secrets) {
      const base = firecrawlBaseUrl(config);
      const headers: Record<string, string> = {};
      const key = secretOrNull(secrets, "api_key");
      if (key !== null) headers["authorization"] = `Bearer ${key}`;
      const res = await fetch(base + "/", fetchTimeout({ headers })).catch((error: unknown) => {
        const cause = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
        throw new Error(`firecrawl unreachable: ${cause}`);
      });
      const body = await res.text().catch(() => "");
      if (!res.ok) throw new Error(`firecrawl rejected the connection (${res.status} ${res.statusText})`);
      if (!body.includes("Firecrawl API")) {
        throw new Error("firecrawl: unexpected response at / (not a Firecrawl API?)");
      }
    },
  },
  {
    name: "google_workspace",
    classes: {
      gmail_search: "read",
      gmail_get_message: "read",
      gmail_get_attachment: "read",
      calendar_list_events: "read",
      drive_search: "read",
      directory_users: "read",
      api: "write",
    },
    tools() {
      return [
        {
          name: "gmail_search",
          description: "Search Gmail and return matching message ids (Gmail query syntax).",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Gmail search query, e.g. 'from:alice has:attachment'" },
              max_results: { type: "number", description: "1-25, default 10" },
            },
            required: ["query"],
          },
        },
        {
          name: "gmail_get_message",
          description:
            "Fetch one Gmail message: headers, text body, and the list of attachment parts (filename, mime, attachment id).",
          parameters: {
            type: "object",
            properties: { message_id: { type: "string" } },
            required: ["message_id"],
          },
        },
        {
          name: "gmail_get_attachment",
          description:
            "Fetch one Gmail attachment as a downloadable file artifact. Get the attachment id from gmail_get_message's attachment list.",
          parameters: {
            type: "object",
            properties: {
              message_id: { type: "string" },
              attachment_id: { type: "string" },
              filename: { type: "string", description: "Override the materialized filename (optional)" },
            },
            required: ["message_id", "attachment_id"],
          },
        },
        {
          name: "calendar_list_events",
          description: "List upcoming events on the primary Google Calendar (time_min defaults to now).",
          parameters: {
            type: "object",
            properties: {
              time_min: { type: "string", description: "RFC3339 lower bound (optional)" },
              time_max: { type: "string", description: "RFC3339 upper bound (optional)" },
              max_results: { type: "number", description: "1-50, default 10" },
            },
          },
        },
        {
          name: "drive_search",
          description: "Search Google Drive files by name substring.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "Filename substring to match" },
              max_results: { type: "number", description: "1-50, default 10" },
            },
            required: ["name"],
          },
        },
        {
          name: "directory_users",
          description: "List Google Workspace directory users (defaults to the admin's domain).",
          parameters: {
            type: "object",
            properties: {
              domain: { type: "string", description: "Domain to list (optional)" },
              max_results: { type: "number", description: "1-50, default 20" },
            },
          },
        },
        apiToolSpec("Google API"),
      ];
    },
    async testConnection(config: Json, secrets) {
      await googleAccessToken(config, secrets);
    },
  },
  {
    name: "hubspot",
    classes: {
      search_contacts: "read",
      search_companies: "read",
      search_deals: "read",
      update_deal: "write",
      api: "write",
    },
    tools() {
      const search = (name: string, noun: string): ConnectorToolSpec => ({
        name,
        description: `Search HubSpot ${noun} by free-text query (CRM v3 search).`,
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            limit: { type: "number", description: "1-100 results, default 10" },
          },
          required: ["query"],
        },
      });
      return [
        search("search_contacts", "contacts"),
        search("search_companies", "companies"),
        search("search_deals", "deals"),
        {
          name: "update_deal",
          description: "Update properties of one HubSpot deal by id.",
          parameters: {
            type: "object",
            properties: {
              id: { type: "string", description: "Deal id (internal numeric id)" },
              properties: {
                type: "object",
                description: 'Deal properties to set, e.g. {"amount": "1000"}',
              },
            },
            required: ["id", "properties"],
          },
        },
        apiToolSpec("HubSpot"),
      ];
    },
    async testConnection(config: Json, secrets) {
      const token = secret(secrets, "token");
      const url = new URL(`${hubspotBaseUrl(config)}/crm/v3/objects/contacts`);
      url.searchParams.set("limit", "1");
      await probe(fetch(url, fetchTimeout({ headers: { authorization: `Bearer ${token}` } })), "hubspot");
    },
  },
  {
    name: "langfuse",
    classes: { list_traces: "read", get_trace: "read", get_prompt: "read", api: "write" },
    tools() {
      return [
        {
          name: "list_traces",
          description: "List recent Langfuse traces (id, name, timestamp).",
          parameters: {
            type: "object",
            properties: { limit: { type: "number", description: "1-50 traces, default 10" } },
          },
        },
        {
          name: "get_trace",
          description: "Fetch one Langfuse trace with its full body by id.",
          parameters: {
            type: "object",
            properties: { trace_id: { type: "string" } },
            required: ["trace_id"],
          },
        },
        {
          name: "get_prompt",
          description: "Fetch one Langfuse prompt by name (latest or a specific version).",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string", description: "Prompt name" },
              version: { type: "number", description: "Specific version (default: latest)" },
            },
            required: ["name"],
          },
        },
        apiToolSpec("Langfuse"),
      ];
    },
    async testConnection(config: Json, secrets) {
      const base = langfuseBaseUrl(config, secrets);
      const public_key = secret(secrets, "public_key");
      const secret_key = secret(secrets, "secret_key");
      const basic = Buffer.from(`${public_key}:${secret_key}`).toString("base64");
      await probe(
        fetch(`${base}/api/public/projects`, fetchTimeout({ headers: { authorization: `Basic ${basic}` } })),
        "langfuse",
      );
    },
  },
  {
    name: "atlassian",
    classes: {
      jira_search: "read",
      jira_get_issue: "read",
      confluence_search: "read",
      confluence_get_page: "read",
      confluence_create_page: "write",
      api: "write",
    },
    tools() {
      return [
        {
          name: "jira_search",
          description: "Search Jira issues with a JQL query (returns key, summary, status, type, assignee).",
          parameters: {
            type: "object",
            properties: {
              jql: { type: "string", description: 'JQL query, e.g. "project = PROJ ORDER BY updated DESC"' },
              max_results: { type: "number", description: "1-50, default 10" },
            },
            required: ["jql"],
          },
        },
        {
          name: "jira_get_issue",
          description: "Fetch one Jira issue by key (summary, status, type, assignee, created, browse URL).",
          parameters: {
            type: "object",
            properties: { issue_key: { type: "string", description: "Issue key, e.g. PROJ-1" } },
            required: ["issue_key"],
          },
        },
        {
          name: "confluence_search",
          description: "Search Confluence with a CQL query (returns page titles, excerpts, ids).",
          parameters: {
            type: "object",
            properties: {
              cql: { type: "string", description: 'CQL query, e.g. "space = PROJ AND type = page"' },
              limit: { type: "number", description: "1-50, default 10" },
            },
            required: ["cql"],
          },
        },
        {
          name: "confluence_get_page",
          description: "Fetch one Confluence page by id — title plus storage body as plain text.",
          parameters: {
            type: "object",
            properties: { page_id: { type: "string", description: "Numeric page id" } },
            required: ["page_id"],
          },
        },
        {
          name: "confluence_create_page",
          description: "Create a Confluence page in a space (title + content in storage XHTML format).",
          parameters: {
            type: "object",
            properties: {
              space_key: { type: "string", description: "Space key, e.g. PROJ" },
              title: { type: "string" },
              content: {
                type: "string",
                description: 'Page body in Confluence storage XHTML format, e.g. "<p>hello</p>"',
              },
            },
            required: ["space_key", "title", "content"],
          },
        },
        apiToolSpec("Atlassian"),
      ];
    },
    async testConnection(config: Json, secrets) {
      // Site and email are plain settings (config wins, the legacy
      // secret-named rows are the fallback); only the token is a credential.
      const site = configString(config, "site") ?? secretOrNull(secrets, "site");
      if (site === undefined || site === null) throw new Error("atlassian requires the site setting");
      const email = configString(config, "email") ?? secretOrNull(secrets, "email");
      if (email === undefined || email === null) throw new Error("atlassian requires the email setting");
      const token = secret(secrets, "token");
      const basic = Buffer.from(`${email}:${token}`).toString("base64");
      await probe(
        fetch(`${trimTrailingSlash(site)}/rest/api/3/myself`, fetchTimeout({ headers: { authorization: `Basic ${basic}` } })),
        "atlassian",
      );
    },
  },
  {
    name: "slack",
    classes: {
      conversations_list: "read",
      conversations_history: "read",
      users_list: "read",
      post_message: "write",
      api: "write",
    },
    tools(config: Json) {
      // `base_url` is optional; when present it must be a string.
      if ("base_url" in config && typeof config["base_url"] !== "string") {
        throw new Error("slack config base_url must be a string");
      }
      const spec = (name: string, description: string, properties: Json): ConnectorToolSpec => ({
        name,
        description,
        parameters: { type: "object", properties },
      });
      return [
        spec(
          "conversations_list",
          "List Slack channels (public and private the bot can see).",
          {
            limit: { type: "number", description: "1-200, default 200" },
            cursor: { type: "string", description: "Pagination cursor from a previous page" },
          },
        ),
        spec(
          "conversations_history",
          "Read the message history of one channel by ID.",
          {
            channel: { type: "string", description: "Channel ID, e.g. C0123456789" },
            limit: { type: "number", description: "1-200 messages, default 200" },
            cursor: { type: "string", description: "Pagination cursor from a previous page" },
          },
        ),
        spec("users_list", "List Slack users in the workspace.", {
          limit: { type: "number", description: "1-200, default 200" },
          cursor: { type: "string", description: "Pagination cursor from a previous page" },
        }),
        spec(
          "post_message",
          "Post a message to a Slack channel through chat.postMessage.",
          {
            channel: { type: "string", description: "Channel ID or name, e.g. C0123456789 or #general" },
            text: { type: "string", description: "Message text (plain text or Slack mrkdwn)" },
          },
        ),
        apiToolSpec("Slack Web API"),
      ];
    },
    async testConnection(config: Json, secrets) {
      if ("base_url" in config && typeof config["base_url"] !== "string") {
        throw new Error("slack config base_url must be a string");
      }
      const base = slackBaseUrl(config);
      const token = secret(secrets, "bot_token");
      // Slack answers HTTP 200 with {"ok": false, ...} for an invalid or
      // revoked token: the body verdict decides, not the status.
      let res: Response;
      try {
        res = await fetch(`${base}/auth.test`, fetchTimeout({
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
        }));
      } catch (error) {
        const cause = error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
        throw new Error(`slack unreachable: ${cause}`);
      }
      let body: Json = {};
      try {
        body = (await res.json()) as Json;
      } catch {
        body = {};
      }
      const okStatus = res.ok;
      if (okStatus && body["ok"] === true) return;
      if (okStatus) {
        throw new Error(`slack rejected the token (${typeof body["error"] === "string" ? body["error"] : "ok=false"})`);
      }
      throw new Error(`slack rejected the connection (${res.status} ${res.statusText})`);
    },
  },
  {
    name: "github",
    classes: {
      search_repositories: "read",
      list_issues: "read",
      list_pulls: "read",
      get_file: "read",
      create_issue: "write",
      api: "write",
    },
    tools() {
      return [
        {
          name: "search_repositories",
          description: "Search GitHub repositories (name, url, language, stars).",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              per_page: { type: "number", description: "1-50, default 10" },
            },
            required: ["query"],
          },
        },
        {
          name: "list_issues",
          description: "List issues of one repository (pull requests are excluded).",
          parameters: {
            type: "object",
            properties: {
              owner: { type: "string" },
              repo: { type: "string" },
              state: { type: "string", enum: ["open", "closed", "all"], description: "default open" },
              per_page: { type: "number", description: "1-50, default 20" },
            },
            required: ["owner", "repo"],
          },
        },
        {
          name: "list_pulls",
          description: "List pull requests of one repository.",
          parameters: {
            type: "object",
            properties: {
              owner: { type: "string" },
              repo: { type: "string" },
              state: { type: "string", enum: ["open", "closed", "all"], description: "default open" },
              per_page: { type: "number", description: "1-50, default 20" },
            },
            required: ["owner", "repo"],
          },
        },
        {
          name: "get_file",
          description: "Fetch one file's text content from a repository.",
          parameters: {
            type: "object",
            properties: {
              owner: { type: "string" },
              repo: { type: "string" },
              path: { type: "string", description: "File path inside the repo" },
              ref: { type: "string", description: "Branch, tag, or sha (default branch)" },
            },
            required: ["owner", "repo", "path"],
          },
        },
        {
          name: "create_issue",
          description: "Open a new issue in one repository.",
          parameters: {
            type: "object",
            properties: {
              owner: { type: "string" },
              repo: { type: "string" },
              title: { type: "string" },
              body: { type: "string" },
              labels: { type: "array", items: { type: "string" } },
            },
            required: ["owner", "repo", "title"],
          },
        },
        apiToolSpec("GitHub"),
      ];
    },
    async testConnection(config: Json, secrets) {
      const token = secret(secrets, "token");
      await probe(
        fetch(`${githubApiUrl(config)}/user`, fetchTimeout({ headers: { authorization: `Bearer ${token}` } })),
        "github",
      );
    },
  },
  {
    name: "gitlab",
    classes: {
      list_projects: "read",
      list_issues: "read",
      list_mrs: "read",
      create_issue: "write",
      api: "write",
    },
    tools() {
      return [
        {
          name: "list_projects",
          description: "List GitLab projects visible to the token (id, path, url).",
          parameters: {
            type: "object",
            properties: {
              search: { type: "string", description: "Optional name filter" },
              per_page: { type: "number", description: "1-50, default 20" },
            },
            required: [],
          },
        },
        {
          name: "list_issues",
          description: "List issues of one project (numeric id or group/project path).",
          parameters: {
            type: "object",
            properties: {
              project: { type: "string" },
              state: { type: "string", enum: ["opened", "closed", "all"], description: "default opened" },
              per_page: { type: "number", description: "1-50, default 20" },
            },
            required: ["project"],
          },
        },
        {
          name: "list_mrs",
          description: "List merge requests of one project.",
          parameters: {
            type: "object",
            properties: {
              project: { type: "string" },
              state: {
                type: "string",
                enum: ["opened", "closed", "merged", "all"],
                description: "default opened",
              },
              per_page: { type: "number", description: "1-50, default 20" },
            },
            required: ["project"],
          },
        },
        {
          name: "create_issue",
          description: "Open a new issue in one project.",
          parameters: {
            type: "object",
            properties: {
              project: { type: "string" },
              title: { type: "string" },
              description: { type: "string" },
            },
            required: ["project", "title"],
          },
        },
        apiToolSpec("GitLab"),
      ];
    },
    async testConnection(config: Json, secrets) {
      const token = secret(secrets, "token");
      await probe(
        fetch(`${gitlabBaseUrl(config)}/user`, fetchTimeout({ headers: { authorization: `Bearer ${token}` } })),
        "gitlab",
      );
    },
  },
];

export function builtinConnectorByName(name: string): BuiltinConnector | undefined {
  return BUILTIN_CONNECTORS.find((c) => c.name === name);
}

/** Effective manifest class for one tool (guild_core tool_class): the
 *  declared class or read. */
export function toolClassOf(connector: BuiltinConnector, tool: string): string {
  const declared = connector.classes[tool];
  if (declared === "write" || declared === "admin") return declared;
  return "read";
}

/** The manifest tool classes of a registry v2 integration manifest (the
 *  same rule as guild_core tool_class over a BundleManifest). */
export function manifestToolClass(manifest: Json | null, tool: string): string {
  const tools = manifest?.["tools"];
  if (tools !== null && typeof tools === "object" && !Array.isArray(tools)) {
    const classes = (tools as Json)["classes"];
    if (classes !== null && typeof classes === "object" && !Array.isArray(classes)) {
      const c = (classes as Json)[tool];
      if (c === "write" || c === "admin") return c;
      if (typeof c === "string") return "read";
    }
  }
  return "read";
}
