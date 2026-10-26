import { secretOrNull, superproxyBaseUrl, configString } from "../shared.js";
import { fetchTimeout, probe } from "../probe.js";
import type { Json } from "../shared.js";
import type { IntegrationPlugin } from "../types.js";
import { superproxyExecute } from "./execute.js";

const plugin: IntegrationPlugin = {
  manifest: {
    name: "superproxy",
    title: "Superproxy",
    version: "1.0.0",
    publisher: "Guild",
    summary: "Fetch web pages as markdown through the superproxy gateway",
    description:
      "Adds web fetch to chats. The integration sends one URL to the superproxy " +
      "gateway and gets back the page as markdown: title, description, main text, " +
      "and no navigation chrome.\n\n" +
      "Superproxy handles the extraction, the proxy pool, and the rate limits, so " +
      "a chat reads a page without a browser.",
    docs_url: null,
    categories: ["fetch"],
    traits: { web_fetch: "web_fetch" },
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      {
        name: "base_url",
        kind: "string",
        label: "Gateway URL",
        required: true,
        default: null,
        help: "Base URL of the superproxy gateway",
        placeholder: "http://superproxy:15505",
      },
      {
        name: "token",
        kind: "string",
        label: "Gateway token (legacy)",
        required: false,
        default: null,
        help: "Legacy fallback; prefer storing the token secret instead",
        placeholder: null,
      },
    ],
    tools: [
      {
        name: "web_fetch",
        class: "read",
        description:
          "Fetch a web page through the superproxy gateway and return its " +
          "content as markdown (title, description, main text).",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "Absolute http(s) URL to fetch" },
            max_chars: { type: "number", description: "Max characters of returned content (default 8000)" },
          },
          required: ["url"],
        },
      },
    ],
  },
  validate(config: Json) {
    superproxyBaseUrl(config);
  },
  async testConnection(config: Json, secrets) {
    const url = new URL(`${superproxyBaseUrl(config)}/v1/fetch`);
    url.searchParams.set("url", "https://example.com");
    url.searchParams.set("format", "markdown");
    const token = secretOrNull(secrets, "token") ?? configString(config, "token");
    const headers: Record<string, string> = {};
    if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
    await probe(fetch(url, fetchTimeout({ headers })), "superproxy");
  },
  execute: superproxyExecute,
};

export default plugin;
