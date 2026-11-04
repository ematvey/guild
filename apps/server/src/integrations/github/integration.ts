import { githubApiUrl, secret } from "../shared.js";
import { PROBE_TIMEOUT_MS, probe } from "@guild/integration-sdk";
import { fetchTimeout } from "../shared.js";
import type { JsonObject } from "../shared.js";
import type { IntegrationPlugin } from "@guild/integration-sdk";
import { githubExecute } from "./execute.js";
import { apiTool } from "@guild/integration-sdk";

const plugin: IntegrationPlugin = {
  manifest: {
    name: "github",
    title: "GitHub",
    version: "1.0.0",
    publisher: "Guild",
    summary: "GitHub repositories, issues, pull requests, and files",
    description:
      "Adds GitHub to chats. Search repositories, list issues and pull requests, " +
      "read a file, and open an issue.\n\n" +
      "Access uses a personal access token or a fine-grained token. Point the API " +
      "URL at a GitHub Enterprise Server host when the org runs its own instance.",
    docs_url: "https://docs.github.com/en/rest",
    categories: ["code"],
    traits: {},
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      {
        name: "api_url",
        kind: "string",
        label: "API URL",
        required: false,
        default: "https://api.github.com",
        help: "Override for GitHub Enterprise Server",
        placeholder: null,
      },
      {
        name: "token",
        kind: "secret",
        label: "Access token",
        required: true,
        default: null,
        help: null,
        placeholder: "ghp_…",
      },
    ],
    tools: [
      {
        name: "search_repositories",
        class: "read",
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
        class: "read",
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
        class: "read",
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
        class: "read",
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
        class: "write",
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
      apiTool("GitHub"),
    ],
  },
  async testConnection(config: JsonObject, secrets) {
    const token = secret(secrets, "token");
    await probe(
      fetch(
        `${githubApiUrl(config)}/user`,
        fetchTimeout(PROBE_TIMEOUT_MS, { headers: { authorization: `Bearer ${token}` } }),
      ),
      "github",
    );
  },
  execute: githubExecute,
};

export default plugin;
