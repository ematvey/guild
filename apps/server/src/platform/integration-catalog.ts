// The compiled-in integration kinds: name, categories, settings schema,
// secret names, tool classes, tool declarations, connection tests, and the
// execute function. This is the single declaration list; the admin API,
// turn resolver, and dispatcher derive from it.

import {
  atlassianSite,
  configString,
  firecrawlBaseUrl,
  githubApiUrl,
  gitlabBaseUrl,
  hubspotBaseUrl,
  langfuseBaseUrl,
  secret,
  secretOrNull,
  searxngBaseUrl,
  slackBaseUrl,
  superproxyBaseUrl,
  trimTrailingSlash,
  FIRECRAWL_DEFAULT_BASE_URL,
  type Json,
  type ToolOutcome,
} from "./integrations/vendors/shared.js";
import { googleAccessTokenFor } from "./integrations/vendors/google-workspace.js";
import { searxngExecute } from "./integrations/vendors/searxng.js";
import { superproxyExecute } from "./integrations/vendors/superproxy.js";
import { firecrawlExecute } from "./integrations/vendors/firecrawl.js";
import { googleWorkspaceExecute } from "./integrations/vendors/google-workspace.js";
import { hubspotExecute } from "./integrations/vendors/hubspot.js";
import { langfuseExecute } from "./integrations/vendors/langfuse.js";
import { atlassianExecute } from "./integrations/vendors/atlassian.js";
import { slackExecute } from "./integrations/vendors/slack.js";
import { githubExecute } from "./integrations/vendors/github.js";
import { gitlabExecute } from "./integrations/vendors/gitlab.js";

/** One admin-facing configuration field (guild_core FieldSpec). */
export interface FieldSpec {
  name: string;
  /** string | text | number | boolean | secret */
  kind: string;
  label: string | null;
  required: boolean;
  default: unknown;
  help: string | null;
  placeholder: string | null;
}

/** In-code manifest metadata (guild_core BundleManifest, kind integration). */
export interface IntegrationManifest {
  name: string;
  version: string;
  description: string;
  /** Display order: search, fetch, other (category_strings display_rank). */
  categories: string[];
  /** Credential field names: secret-kind fields derive them; otherwise the
   *  declared list (same rule as in_code_manifest). */
  secret_names: string[];
  auth_kind: string;
  identity_key: string;
  fields: FieldSpec[];
}

export interface IntegrationToolSpec {
  name: string;
  description: string;
  /** JSON Schema object. */
  parameters: unknown;
}

export interface BuiltinIntegration extends IntegrationManifest {
  /** In-code manifest tool classes (the policy floor; undeclared = read). */
  classes: Record<string, string>;
  /** Validates the row config (throws on a broken one) and declares the
   *  tool surface the integration contributes. */
  tools(config: Record<string, unknown>): IntegrationToolSpec[];
  /** The save gate's connection test against the would-be state; throws
   *  with the Rust connector's error text on failure. */
  testConnection(config: Record<string, unknown>, secrets: [string, string][]): Promise<void>;
  execute(config: Json, tool: string, args: Json, secrets: [string, string][], actingAs: string | null): Promise<ToolOutcome>;
}

function field(
  name: string,
  kind: string,
  extra: Partial<Omit<FieldSpec, "name" | "kind">> = {},
): FieldSpec {
  return {
    name,
    kind,
    label: null,
    required: false,
    default: null,
    help: null,
    placeholder: null,
    ...extra,
  };
}

const PROBE_TIMEOUT_MS = 15_000;

/** The probe contract: any 2xx passes; a transport
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

/** The generic `api` tool every REST-connector exposes (api_tool_spec). */
function apiToolSpec(vendor: string): IntegrationToolSpec {
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

/** The compiled-in kinds, in registry order (integration_names()). */
export const INTEGRATIONS: BuiltinIntegration[] = [
{
    name: "searxng",
    version: "1.0.0",
    description: "Web search through a SearxNG instance",
    categories: ["search"],
    secret_names: [],
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      field("base_url", "string", {
        required: true,
        placeholder: "http://searxng:8080",
      }),
    ],
  
    execute: searxngExecute,
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
      const url = new URL(`${searxngBaseUrl(config)}/search`);
      url.searchParams.set("q", "guild");
      url.searchParams.set("format", "json");
      await probe(fetch(url, fetchTimeout()), "searxng");
    },
  },
{
    name: "superproxy",
    version: "1.0.0",
    description: "Fetch web pages as markdown through the superproxy gateway",
    categories: ["fetch"],
    // No declared secrets: the gateway token is optional (legacy config
    // fallback), so the enable gate must not require it.
    secret_names: [],
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      field("base_url", "string", {
        required: true,
        placeholder: "http://superproxy:15505",
      }),
      field("token", "string", {
        help: "Legacy fallback; prefer storing the token secret instead",
      }),
    ],
  
    execute: superproxyExecute,
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
      const url = new URL(`${superproxyBaseUrl(config)}/v1/fetch`);
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
    version: "1.0.0",
    description:
      "Search the web and fetch pages as markdown through a self-hosted Firecrawl API (plus site link mapping; crawl jobs are not exposed as tools)",
    categories: ["search", "fetch"],
    secret_names: ["api_key"],
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      field("base_url", "string", {
        default: FIRECRAWL_DEFAULT_BASE_URL,
        help: "Self-hosted Firecrawl API URL",
      }),
      field("api_key", "secret", {
        help: "Sent as the Bearer token; the self-hosted API does not require it",
      }),
    ],
  
    execute: firecrawlExecute,
    classes: { web_search: "read", web_fetch: "read", map: "read" },
    tools() {
      return [
        {
          name: "web_fetch",
          description: "Fetch a web page through the Firecrawl API and return its content as markdown.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "Absolute http(s) URL to fetch" },
              max_chars: {
                type: "number",
                description: "Max characters of returned markdown (default 8000)",
              },
            },
            required: ["url"],
          },
        },
        {
          name: "web_search",
          description: "Search the web through the Firecrawl API and return the top results (title, url, description).",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string" },
              count: { type: "number", description: "1-20, default 5" },
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
    version: "1.0.0",
    description: "Read-only Google Workspace tools: Gmail, Calendar, Drive, Admin Directory",
    categories: ["other"],
    secret_names: ["service_account_json"],
    // Org-wide service account; the per-call acting identity rides the
    // token `sub` claim (identity_key "email").
    auth_kind: "org_secret_impersonated",
    identity_key: "email",
    fields: [
      field("api_base", "string", {
        default: "https://www.googleapis.com",
        help: "Override only for a Google API proxy",
      }),
      field("token_url", "string", {
        default: "https://oauth2.googleapis.com/token",
        help: "Override only for a Google API proxy",
      }),
      field("admin_email", "string", {
        required: true,
        help: "workspace admin the service account acts as by default",
        placeholder: "admin@yourorg.com",
      }),
      field("service_account_json", "secret", { required: true }),
    ],
  
    execute: googleWorkspaceExecute,
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
      await googleAccessTokenFor(config, secrets, null);
    },
  },
{
    name: "hubspot",
    version: "1.0.0",
    description: "HubSpot CRM: search contacts, companies, and deals; update deals",
    categories: ["other"],
    secret_names: ["token"],
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      field("base_url", "string", {
        default: "https://api.hubapi.com",
        help: "Override only for a HubSpot API proxy",
      }),
      field("token", "secret", { required: true }),
    ],
  
    execute: hubspotExecute,
    classes: {
      search_contacts: "read",
      search_companies: "read",
      search_deals: "read",
      update_deal: "write",
      api: "write",
    },
    tools() {
      const search = (name: string, noun: string): IntegrationToolSpec => ({
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
    version: "1.0.0",
    description: "Langfuse LLM observability: list and inspect traces, list prompts",
    categories: ["other"],
    secret_names: ["public_key", "secret_key"],
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      field("base_url", "string", {
        default: "https://cloud.langfuse.com",
        help: "Override for self-hosted Langfuse",
      }),
      field("public_key", "secret", { required: true }),
      field("secret_key", "secret", { required: true }),
    ],
  
    execute: langfuseExecute,
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
    version: "1.0.0",
    description: "Jira and Confluence Cloud: search and read issues and pages, create pages",
    categories: ["other"],
    secret_names: ["token"],
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      field("site", "string", {
        required: true,
        placeholder: "https://yourorg.atlassian.net",
        help: "your Jira/Confluence cloud site",
      }),
      field("email", "string", {
        required: true,
        help: "the account the API token belongs to",
      }),
      field("token", "secret", { required: true }),
    ],
  
    execute: atlassianExecute,
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
      const site = atlassianSite(config, secrets);
      const email = configString(config, "email") ?? secretOrNull(secrets, "email");
      if (email === undefined || email === null) throw new Error("atlassian requires the email setting");
      const token = secret(secrets, "token");
      const basic = Buffer.from(`${email}:${token}`).toString("base64");
      await probe(
        fetch(`${site}/rest/api/3/myself`, fetchTimeout({ headers: { authorization: `Basic ${basic}` } })),
        "atlassian",
      );
    },
  },
{
    name: "slack",
    version: "1.0.0",
    description: "Slack: list channels and users, read channel history, post messages",
    categories: ["other"],
    secret_names: ["bot_token"],
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      field("base_url", "string", {
        default: "https://slack.com/api",
        help: "Override only for a Slack API proxy",
      }),
      field("bot_token", "secret", { required: true }),
    ],
  
    execute: slackExecute,
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
      const spec = (name: string, description: string, properties: Json): IntegrationToolSpec => ({
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
    version: "1.0.0",
    description: "GitHub repositories, issues, pull requests, and files",
    categories: ["other"],
    secret_names: ["token"],
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      field("api_url", "string", {
        default: "https://api.github.com",
        help: "Override for GitHub Enterprise Server",
      }),
      field("token", "secret", { required: true }),
    ],
  
    execute: githubExecute,
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
    version: "1.0.0",
    description: "GitLab projects, issues, and merge requests",
    categories: ["other"],
    secret_names: ["token"],
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      field("base_url", "string", {
        default: "https://gitlab.com/api/v4",
        help: "Override for self-hosted GitLab (API root)",
      }),
      field("token", "secret", { required: true }),
    ],
  
    execute: gitlabExecute,
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
  }
];

export function integrationByName(name: string): BuiltinIntegration | undefined {
  return INTEGRATIONS.find((c) => c.name === name);
}

export const INTEGRATION_NAMES: string[] = INTEGRATIONS.map((c) => c.name);
