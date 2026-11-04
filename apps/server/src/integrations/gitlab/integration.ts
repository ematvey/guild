import { gitlabBaseUrl, secret } from "../shared.js";
import { PROBE_TIMEOUT_MS, probe } from "@guild/integration-sdk";
import { fetchTimeout } from "../shared.js";
import type { JsonObject } from "../shared.js";
import type { IntegrationPlugin } from "@guild/integration-sdk";
import { gitlabExecute } from "./execute.js";
import { apiTool } from "@guild/integration-sdk";

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
        obtain:
          "Leave the default for gitlab.com. For self-managed GitLab enter its address, such as " +
          "`https://gitlab.example.com`; Guild adds `/api/v4` to a bare host. If GitLab is served " +
          "under a path, enter the full API root, such as `https://example.com/gitlab/api/v4`.",
      },
      {
        name: "token",
        kind: "secret",
        label: "Access token",
        required: true,
        default: null,
        help: null,
        placeholder: "glpat-…",
        obtain:
          "Create a personal access token under [User settings → Access " +
          "tokens](https://gitlab.com/-/user_settings/personal_access_tokens) (or a group or " +
          "project access token under **Settings → Access tokens**) with the `api` scope. " +
          "`read_api` is enough if agents should not open issues. The token's user needs at least " +
          "the Reporter role on the projects agents should read.",
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
