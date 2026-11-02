import { atlassianSite, configString, secret, secretOrNull } from "../shared.js";
import { PROBE_TIMEOUT_MS, probe } from "../probe.js";
import { fetchTimeout } from "../shared.js";
import type { JsonObject } from "../shared.js";
import type { IntegrationPlugin } from "../types.js";
import { atlassianExecute } from "./execute.js";
import { apiTool } from "../api-tool.js";

const plugin: IntegrationPlugin = {
  manifest: {
    name: "atlassian",
    title: "Atlassian",
    version: "1.0.0",
    publisher: "Guild",
    summary: "Jira and Confluence Cloud: search and read issues and pages, create pages",
    description:
      "Adds Jira and Confluence to chats. Search issues with JQL, read one issue, " +
      "search Confluence with CQL, read a page as text, and create a page in a " +
      "space.\n\n" +
      "Access uses an Atlassian API token with the account email. The account's " +
      "permissions decide what the tools can see and write.",
    docs_url: "https://developer.atlassian.com/cloud/jira/platform/rest/v3/intro/",
    categories: ["docs"],
    traits: {},
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      {
        name: "site",
        kind: "string",
        label: "Site URL",
        required: true,
        default: null,
        help: "Your Jira/Confluence cloud site",
        placeholder: "https://yourorg.atlassian.net",
      },
      {
        name: "email",
        kind: "string",
        label: "Account email",
        required: true,
        default: null,
        help: "The account the API token belongs to",
        placeholder: null,
      },
      {
        name: "token",
        kind: "secret",
        label: "API token",
        required: true,
        default: null,
        help: null,
        placeholder: null,
      },
    ],
    tools: [
      {
        name: "jira_search",
        class: "read",
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
        class: "read",
        description: "Fetch one Jira issue by key (summary, status, type, assignee, created, browse URL).",
        parameters: {
          type: "object",
          properties: { issue_key: { type: "string", description: "Issue key, e.g. PROJ-1" } },
          required: ["issue_key"],
        },
      },
      {
        name: "confluence_search",
        class: "read",
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
        class: "read",
        description: "Fetch one Confluence page by id — title plus storage body as plain text.",
        parameters: {
          type: "object",
          properties: { page_id: { type: "string", description: "Numeric page id" } },
          required: ["page_id"],
        },
      },
      {
        name: "confluence_create_page",
        class: "write",
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
      apiTool("Atlassian"),
    ],
  },
  async testConnection(config: JsonObject, secrets) {
    // Site and email are plain settings (config wins, the legacy
    // secret-named rows are the fallback); only the token is a credential.
    const site = atlassianSite(config, secrets);
    const email = configString(config, "email") ?? secretOrNull(secrets, "email");
    if (email === undefined || email === null) throw new Error("atlassian requires the email setting");
    const token = secret(secrets, "token");
    const basic = Buffer.from(`${email}:${token}`).toString("base64");
    await probe(
      fetch(`${site}/rest/api/3/myself`, fetchTimeout(PROBE_TIMEOUT_MS, { headers: { authorization: `Basic ${basic}` } })),
      "atlassian",
    );
  },
  execute: atlassianExecute,
};

export default plugin;
