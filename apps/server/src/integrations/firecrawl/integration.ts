import { firecrawlBaseUrl, secretOrNull, FIRECRAWL_DEFAULT_BASE_URL } from "../shared.js";
import { fetchTimeout } from "../probe.js";
import type { JsonObject } from "../shared.js";
import type { IntegrationPlugin } from "../types.js";
import { firecrawlExecute } from "./execute.js";

const plugin: IntegrationPlugin = {
  manifest: {
    name: "firecrawl",
    title: "Firecrawl",
    version: "1.0.0",
    publisher: "Guild",
    summary: "Search the web and fetch pages as markdown through a self-hosted Firecrawl API (plus site link mapping; crawl jobs are not exposed as tools)",
    description:
      "Adds web search, web fetch, and site mapping to chats through a " +
      "self-hosted Firecrawl API.\n\n" +
      "Search returns titles, URLs, and descriptions. Fetch returns one page as " +
      "markdown. Map lists the links Firecrawl discovers on a site, which is " +
      "useful before crawling a documentation tree by hand. Crawl jobs are not " +
      "exposed as tools.",
    docs_url: "https://docs.firecrawl.dev/",
    categories: ["search", "fetch"],
    traits: { web_search: "web_search", web_fetch: "web_fetch" },
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      {
        name: "base_url",
        kind: "string",
        label: "API URL",
        required: false,
        default: FIRECRAWL_DEFAULT_BASE_URL,
        help: "Self-hosted Firecrawl API URL",
        placeholder: null,
      },
      {
        name: "api_key",
        kind: "secret",
        label: "API key",
        required: false,
        default: null,
        help: "Sent as the Bearer token; the self-hosted API does not require it",
        placeholder: null,
      },
    ],
    tools: [
      {
        name: "web_fetch",
        class: "read",
        description: "Fetch a web page through the Firecrawl API and return its content as markdown.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Absolute http(s) URL to fetch" },
            max_chars: { type: "number", description: "Max characters of returned markdown (default 8000)" },
          },
          required: ["url"],
        },
      },
      {
        name: "web_search",
        class: "read",
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
        class: "read",
        description: "List the links Firecrawl discovers on one site (sitemap style crawl).",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Absolute http(s) URL of the site root" },
          },
          required: ["url"],
        },
      },
    ],
  },
  validate(config: JsonObject) {
    firecrawlBaseUrl(config);
  },
  async testConnection(config: JsonObject, secrets) {
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
  execute: firecrawlExecute,
};

export default plugin;
