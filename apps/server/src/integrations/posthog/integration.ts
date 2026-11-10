import { posthogBase, posthogExecute, posthogJson, posthogProject } from "./execute.js";
import type { JsonObject } from "../shared.js";
import type { IntegrationPlugin } from "@guild/integration-sdk";
import { apiTool } from "@guild/integration-sdk";

const plugin: IntegrationPlugin = {
  manifest: {
    name: "posthog",
    title: "PostHog",
    version: "1.0.0",
    publisher: "Guild",
    summary: "Product analytics: query events, read insights, dashboards and feature flags",
    description:
      "Adds product analytics to chats. Run a HogQL query over events and " +
      "persons, list and read the saved insights and dashboards, list the " +
      "feature flags, and look up one person.\n\n" +
      "One integration points at one PostHog project. The project id is part " +
      "of every call, so the answers always come from that project and never " +
      "from a neighbouring one. Use HogQL for anything the named tools do not " +
      "cover: it reads events, persons and sessions with SQL.\n\n" +
      "Access uses a personal API key of a PostHog user. Give that user a " +
      "project-scoped key with read scopes only: every named tool reads.",
    docs_url: "https://posthog.com/docs/api",
    categories: ["analytics"],
    traits: {},
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      {
        name: "base_url",
        kind: "string",
        label: "PostHog URL",
        required: true,
        default: null,
        help: "Address of the PostHog instance",
        placeholder: "https://us.posthog.com",
        obtain:
          "The address you open PostHog at: `https://us.posthog.com` or `https://eu.posthog.com` " +
          "for PostHog Cloud, or your self-hosted address such as `https://analytics.example.com`. " +
          "No `/api` suffix. It must be reachable from the Guild server.",
      },
      {
        name: "project_id",
        kind: "number",
        label: "Project ID",
        required: true,
        default: null,
        help: "Numeric id of the PostHog project the tools read",
        placeholder: "12345",
        obtain:
          "In PostHog open **Project settings** and read the **Project ID** field. It is the number " +
          "in `/project/<id>` URLs. The key must be scoped to this project, or the calls fail with " +
          "404 or 403.",
      },
      {
        name: "api_key",
        kind: "secret",
        label: "Personal API key",
        required: true,
        default: null,
        help: null,
        placeholder: "phx_…",
        obtain:
          "In PostHog open **Settings → Personal API keys → Create personal API key**. Choose " +
          "**Project-scoped** and select the project above, then grant the read scopes: " +
          "`query:read`, `insight:read`, `dashboard:read`, `feature_flag:read`, `person:read`. " +
          "Copy the key (`phx_…`) when PostHog shows it: it is not shown again.",
      },
    ],
    tools: [
      {
        name: "query",
        class: "read",
        description:
          "Run a HogQL query (PostHog's SQL dialect) against this project and " +
          "read the answer as a table. HogQL reads `events`, `persons`, " +
          "`sessions` and the property columns. Example: select event, count() " +
          "from events where timestamp > now() - interval 7 day group by event " +
          "order by 2 desc.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "HogQL SELECT statement" },
            max_rows: { type: "number", description: "1-500 rows to show, default 50" },
          },
          required: ["query"],
        },
      },
      {
        name: "list_insights",
        class: "read",
        description: "List the saved insights of the project with their id, short_id and name.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Name substring filter" },
            limit: { type: "number", description: "1-100 insights, default 20" },
          },
        },
      },
      {
        name: "get_insight",
        class: "read",
        description: "Read one insight by id or short_id: name, kind, tags and its query definition.",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Insight id or short_id from list_insights" },
          },
          required: ["id"],
        },
      },
      {
        name: "list_dashboards",
        class: "read",
        description: "List the dashboards of the project with their id and description.",
        parameters: {
          type: "object",
          properties: { limit: { type: "number", description: "1-100 dashboards, default 20" } },
        },
      },
      {
        name: "get_dashboard",
        class: "read",
        description: "Read one dashboard by id: name, description, and the insights on it.",
        parameters: {
          type: "object",
          properties: { id: { type: "number", description: "Dashboard id from list_dashboards" } },
          required: ["id"],
        },
      },
      {
        name: "list_feature_flags",
        class: "read",
        description: "List the feature flags with their key, active state, rollout and name.",
        parameters: {
          type: "object",
          properties: { limit: { type: "number", description: "1-100 flags, default 20" } },
        },
      },
      {
        name: "search_persons",
        class: "read",
        description:
          "Find persons by a search term (email, distinct id or a property value) and read " +
          "their identified state and last seen time.",
        parameters: {
          type: "object",
          properties: {
            search: { type: "string", description: "Search term; empty lists the newest persons" },
            limit: { type: "number", description: "1-50 persons, default 10" },
          },
        },
      },
      apiTool("PostHog"),
    ],
  },
  validate(config: JsonObject) {
    posthogBase(config);
    posthogProject(config);
  },
  async testConnection(config: JsonObject, secrets) {
    // The project read is the smallest call that proves the key, the project
    // and the instance belong together. A refusal carries the reason in its
    // body ("API key missing required scope 'project:read'"), so the request
    // reports the body and not just the status.
    await posthogJson(config, secrets, `/api/projects/${posthogProject(config)}/`);
  },
  execute: posthogExecute,
};

export default plugin;
