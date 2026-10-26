import { searxngBaseUrl } from "../shared.js";
import { fetchTimeout, probe } from "../probe.js";
import type { Json } from "../shared.js";
import type { IntegrationPlugin } from "../types.js";
import { searxngExecute } from "./execute.js";

const plugin: IntegrationPlugin = {
  manifest: {
    name: "searxng",
    title: "SearxNG",
    version: "1.0.0",
    publisher: "Guild",
    summary: "Web search through a SearxNG instance",
    description:
      "Adds web search to chats. The integration points at one SearxNG instance " +
      "and asks it for JSON results.\n\n" +
      "SearxNG is a self-hosted metasearch engine: it queries other engines and " +
      "returns the merged results. No account, no query logs, no vendor key.",
    docs_url: "https://docs.searxng.org/",
    categories: ["search"],
    traits: { web_search: "web_search" },
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      {
        name: "base_url",
        kind: "string",
        label: "Instance URL",
        required: true,
        default: null,
        help: "Base URL of the SearxNG instance, without /search",
        placeholder: "http://searxng:8080",
      },
    ],
    tools: [
      {
        name: "web_search",
        class: "read",
        description: "Search the web and return the top results (title, url, snippet).",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string" },
            count: { type: "number", description: "1-10, default 5" },
          },
          required: ["query"],
        },
      },
    ],
  },
  validate(config: Json) {
    searxngBaseUrl(config);
  },
  async testConnection(config: Json) {
    const url = new URL(`${searxngBaseUrl(config)}/search`);
    url.searchParams.set("q", "guild");
    url.searchParams.set("format", "json");
    await probe(fetch(url, fetchTimeout()), "searxng");
  },
  execute: searxngExecute,
};

export default plugin;
