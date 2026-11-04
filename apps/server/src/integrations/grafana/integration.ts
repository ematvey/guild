import { grafanaBase } from "./execute.js";
import { PROBE_TIMEOUT_MS, probe } from "@guild/integration-sdk";
import { fetchTimeout } from "../shared.js";
import type { JsonObject } from "../shared.js";
import type { IntegrationPlugin } from "@guild/integration-sdk";
import { grafanaExecute } from "./execute.js";
import { apiTool } from "@guild/integration-sdk";

function tokenOf(secrets: [string, string][]): string {
  const found = secrets.find(([name]) => name === "token");
  if (found === undefined || found[1] === "") throw new Error("grafana requires the token secret");
  return found[1];
}

const plugin: IntegrationPlugin = {
  manifest: {
    name: "grafana",
    title: "Grafana",
    version: "1.0.0",
    publisher: "Guild",
    summary: "Metrics, logs, dashboards, and alerts from one Grafana instance",
    description:
      "Adds observability to chats. Query Prometheus metrics with PromQL, query " +
      "Loki logs with LogQL, list and read dashboards, list datasources, and read " +
      "the active alerts.\n\n" +
      "One integration points at one Grafana instance. Datasources are named per " +
      "region or per pipeline on the server, so every tool takes an optional " +
      "`datasource` argument and reports the datasource it used. Never compare " +
      "two regions just because the dashboard names match.\n\n" +
      "Access uses a Grafana service-account token. Give that account the Viewer " +
      "role: every tool here reads.",
    docs_url: "https://grafana.com/docs/grafana/latest/developers/http_api/",
    categories: ["observability"],
    traits: {},
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      {
        name: "base_url",
        kind: "string",
        label: "Grafana URL",
        required: true,
        default: null,
        help: "Base URL of the Grafana instance",
        placeholder: "https://grafana.example.com",
      },
      {
        name: "org_id",
        kind: "number",
        label: "Organization ID",
        required: false,
        default: 1,
        help: "Grafana organization the token belongs to",
        placeholder: "1",
      },
      {
        name: "prometheus_datasource",
        kind: "string",
        label: "Default Prometheus datasource",
        required: false,
        default: "Prometheus",
        help: "Name or uid the metrics tools use when the call names none",
        placeholder: "Prometheus",
      },
      {
        name: "loki_datasource",
        kind: "string",
        label: "Default Loki datasource",
        required: false,
        default: "Loki",
        help: "Name or uid the log tools use when the call names none",
        placeholder: "Loki",
      },
      {
        name: "token",
        kind: "secret",
        label: "Service account token",
        required: true,
        default: null,
        help: null,
        placeholder: "glsa_…",
      },
    ],
    tools: [
      {
        name: "query_metrics",
        class: "read",
        description:
          "Run a PromQL query against one Prometheus datasource. Instant by " +
          "default; pass start and/or end for a range query. The result lists " +
          "the datasource used, the series, and the last value of each.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "PromQL expression" },
            datasource: { type: "string", description: "Datasource name or uid (default: the integration's)" },
            start: { type: "string", description: "Range start, RFC3339 or relative like now-1h" },
            end: { type: "string", description: "Range end, RFC3339 or relative like now" },
            step: { type: "string", description: "Range step, e.g. 60s (default 60s)" },
            time: { type: "string", description: "Instant query evaluation time (default now)" },
            max_series: { type: "number", description: "1-100 series to list, default 20" },
          },
          required: ["query"],
        },
      },
      {
        name: "query_logs",
        class: "read",
        description:
          "Run a LogQL query against one Loki datasource over a time window. " +
          "Returns the newest lines first with their stream labels.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: 'LogQL expression, e.g. {app="api"} |= "error"' },
            datasource: { type: "string", description: "Datasource name or uid (default: the integration's)" },
            start: { type: "string", description: "Window start, RFC3339 (default now-15m)" },
            end: { type: "string", description: "Window end, RFC3339 (default now)" },
            limit: { type: "number", description: "1-500 lines, default 100" },
          },
          required: ["query"],
        },
      },
      {
        name: "list_datasources",
        class: "read",
        description: "List the Grafana datasources with their type and uid, optionally filtered by type.",
        parameters: {
          type: "object",
          properties: {
            type: { type: "string", description: "Filter by datasource type, e.g. prometheus or loki" },
          },
        },
      },
      {
        name: "list_dashboards",
        class: "read",
        description: "List dashboards with their folder and uid, optionally filtered by a title query.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Title substring filter" },
            limit: { type: "number", description: "1-100 dashboards, default 20" },
          },
        },
      },
      {
        name: "get_dashboard",
        class: "read",
        description: "Read one dashboard by uid: title, tags, and the panel list.",
        parameters: {
          type: "object",
          properties: {
            uid: { type: "string", description: "Dashboard uid from list_dashboards" },
          },
          required: ["uid"],
        },
      },
      {
        name: "list_alerts",
        class: "read",
        description: "List the active Grafana alerts with severity, name, start time, and summary.",
        parameters: { type: "object", properties: {} },
      },
      apiTool("Grafana"),
    ],
  },
  validate(config: JsonObject) {
    grafanaBase(config);
  },
  async testConnection(config: JsonObject, secrets) {
    await probe(
      fetch(
        `${grafanaBase(config)}/api/health`,
        fetchTimeout(PROBE_TIMEOUT_MS, { headers: { authorization: `Bearer ${tokenOf(secrets)}` } }),
      ),
      "grafana",
    );
  },
  execute: grafanaExecute,
};

export default plugin;
