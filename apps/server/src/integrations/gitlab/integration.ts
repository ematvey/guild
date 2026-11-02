import { gitlabBaseUrl, secret } from "../shared.js";
import { PROBE_TIMEOUT_MS, probe } from "../probe.js";
import { fetchTimeout } from "../shared.js";
import type { JsonObject } from "../shared.js";
import type { IntegrationPlugin } from "../types.js";
import { gitlabExecute } from "./execute.js";
import { apiTool } from "../api-tool.js";

const plugin: IntegrationPlugin = {
  manifest: {
    name: "gitlab",
    title: "GitLab",
    version: "1.0.0",
    publisher: "Guild",
    summary: "GitLab projects, issues, and merge requests",
    description:
      "Adds GitLab to chats. List the projects the token can see, list issues and " +
      "merge requests of one project, and open an issue.\n\n" +
      "Access uses a personal or project access token. Point the API URL at a " +
      "self-hosted GitLab API root when the org runs its own instance.",
    docs_url: "https://docs.gitlab.com/ee/api/rest/",
    categories: ["code"],
    traits: {},
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      {
        name: "base_url",
        kind: "string",
        label: "API URL",
        required: false,
        default: "https://gitlab.com/api/v4",
        help: "Override for self-hosted GitLab (API root)",
        placeholder: null,
      },
      {
        name: "token",
        kind: "secret",
        label: "Access token",
        required: true,
        default: null,
        help: null,
        placeholder: "glpat-…",
      },
    ],
    tools: [
      {
        name: "list_projects",
        class: "read",
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
        class: "read",
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
        class: "read",
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
        class: "write",
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
      apiTool("GitLab"),
    ],
  },
  async testConnection(config: JsonObject, secrets) {
    const token = secret(secrets, "token");
    await probe(
      fetch(
        `${gitlabBaseUrl(config)}/user`,
        fetchTimeout(PROBE_TIMEOUT_MS, { headers: { authorization: `Bearer ${token}` } }),
      ),
      "gitlab",
    );
  },
  execute: gitlabExecute,
};

export default plugin;
