// PostHog: product analytics through the project API. HogQL runs ad-hoc
// questions over events and persons; the named tools read the saved
// insights, the dashboards, the feature flags and one person. Every call is
// scoped to the configured project: the project id is part of the path, so
// a wrong id reads another project's data or fails.

import {
  CALL_TIMEOUT_MS,
  MAX_BODY_CHARS,
  VENDOR_API_MAX_CHARS,
  callVendorApi,
  clampNumber,
  excerpt,
  requestJson,
  secret,
  truncateWithMarker,
} from "../shared.js";
import type { JsonObject, ToolOutcome } from "../shared.js";

export function posthogBase(config: JsonObject): string {
  const raw = config["base_url"];
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("posthog config requires base_url");
  return raw.trim().replace(/\/+$/, "");
}

function apiKey(secrets: [string, string][]): string {
  return secret(secrets, "api_key");
}

/** The project id as a path segment. Numeric, so a bad value cannot shape
 *  the request path. */
export function posthogProject(config: JsonObject): string {
  const raw = config["project_id"];
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isInteger(n) || n <= 0) throw new Error("posthog config requires a numeric project_id");
  return String(n);
}

/** One JSON request against the project API. */
async function posthogJson(
  config: JsonObject,
  secrets: [string, string][],
  path: string,
  init: RequestInit = {},
): Promise<JsonObject> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${apiKey(secrets)}`,
    accept: "application/json",
  };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return requestJson(
    `${posthogBase(config)}${path}`,
    { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } },
    CALL_TIMEOUT_MS,
    {
      unreachable: (cause) => `posthog unreachable: ${cause}`,
      unreadable: (cause) => `posthog unreachable: ${cause}`,
      status: (status, text) => `posthog ${status} on ${path}: ${excerpt(text, 300)}`,
      badJson: (text) => `posthog returned a non-JSON body on ${path}: ${excerpt(text, 200)}`,
    },
    { emptyBody: {} },
  );
}

/** A project-scoped path: `/api/projects/<id><suffix>`. */
function projectPath(config: JsonObject, suffix: string): string {
  return `/api/projects/${posthogProject(config)}${suffix}`;
}

function listOf(body: JsonObject): JsonObject[] {
  return Array.isArray(body["results"]) ? (body["results"] as JsonObject[]) : [];
}

function countOf(body: JsonObject, rows: JsonObject[]): number {
  const raw = body["count"];
  return typeof raw === "number" ? raw : rows.length;
}

function text(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** A HogQL answer as a pipe-separated table: the column names, then one line
 *  per row. */
function hogqlTable(body: JsonObject, maxRows: number): { text: string; rows: number; more: number } {
  const columns = Array.isArray(body["columns"]) ? (body["columns"] as unknown[]).map(text) : [];
  const results = Array.isArray(body["results"]) ? (body["results"] as unknown[][]) : [];
  if (columns.length === 0) return { text: "The query returned no columns.", rows: 0, more: 0 };
  const lines = [columns.join(" | ")];
  for (const row of results.slice(0, maxRows)) {
    lines.push(Array.isArray(row) ? row.map(text).join(" | ") : text(row));
  }
  const more = Math.max(results.length - maxRows, 0);
  if (more > 0) lines.push(`(${more} more rows)`);
  return { text: lines.join("\n"), rows: results.length, more };
}

/** A feature flag's rollout as one line: the active variant or the percent. */
function rolloutOf(flag: JsonObject): string {
  const filters = (flag["filters"] ?? {}) as JsonObject;
  const groups = Array.isArray(filters["groups"]) ? (filters["groups"] as JsonObject[]) : [];
  if (groups.length === 0) return "-";
  const parts = groups.map((g) => {
    const percent = typeof g["rollout_percentage"] === "number" ? `${g["rollout_percentage"]}%` : "?";
    const properties = Array.isArray(g["properties"]) ? (g["properties"] as JsonObject[]).length : 0;
    return properties === 0 ? percent : `${percent} (${properties} filters)`;
  });
  return parts.join(" + ");
}

export async function posthogExecute(
  config: JsonObject,
  tool: string,
  args: JsonObject,
  secrets: [string, string][],
  _actingAs: string | null,
): Promise<ToolOutcome> {
  switch (tool) {
    case "query": {
      const query = args["query"];
      if (typeof query !== "string" || query.trim() === "") throw new Error("query requires query");
      const maxRows = clampNumber(args, "max_rows", 50, 500);
      const body = await posthogJson(config, secrets, projectPath(config, "/query/"), {
        method: "POST",
        body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
      });
      const error = body["error"];
      if (typeof error === "string" && error !== "") throw new Error(`posthog query error: ${error}`);
      const table = hogqlTable(body, maxRows);
      const [content, truncated] = truncateWithMarker(table.text, MAX_BODY_CHARS);
      return {
        content,
        meta: { card: "posthog", kind: "query", rows: table.rows, more: table.more, truncated },
      };
    }
    case "list_insights": {
      const limit = clampNumber(args, "limit", 20, 100);
      const search = typeof args["query"] === "string" ? (args["query"] as string).trim() : "";
      const suffix = `/insights/?limit=${limit}${search === "" ? "" : `&search=${encodeURIComponent(search)}`}`;
      const body = await posthogJson(config, secrets, projectPath(config, suffix));
      const rows = listOf(body);
      const total = countOf(body, rows);
      if (rows.length === 0) {
        return { content: "No insights.", meta: { card: "posthog", kind: "insights", count: 0 } };
      }
      const content = rows
        .map((i) => {
          const name = text(i["name"]) || text(i["derived_name"]) || "(unnamed)";
          return `${name} | id=${text(i["id"])} | short_id=${text(i["short_id"])}`;
        })
        .join("\n");
      return {
        content: total > rows.length ? `${content}\n(${total} insights in this project)` : content,
        meta: { card: "posthog", kind: "insights", count: rows.length },
      };
    }
    case "get_insight": {
      const id = args["id"];
      const ref = typeof id === "number" ? String(id) : typeof id === "string" ? id.trim() : "";
      if (ref === "") throw new Error("get_insight requires id");
      const body = await posthogJson(
        config,
        secrets,
        projectPath(config, `/insights/${encodeURIComponent(ref)}/?refresh=false`),
      );
      const name = text(body["name"]) || text(body["derived_name"]) || "(unnamed)";
      const query = (body["query"] ?? {}) as JsonObject;
      const source = (query["source"] ?? {}) as JsonObject;
      const kind = text(source["kind"]) || text(query["kind"]) || "?";
      const lines = [
        `${name} (id=${text(body["id"])}, short_id=${text(body["short_id"])})`,
        `kind=${kind} last_refresh=${text(body["last_refresh"])}`,
      ];
      const description = text(body["description"]);
      if (description !== "") lines.push(`description: ${description}`);
      const tags = Array.isArray(body["tags"]) ? (body["tags"] as unknown[]).map(text) : [];
      if (tags.length > 0) lines.push(`tags: ${tags.join(", ")}`);
      lines.push(`query: ${JSON.stringify(source)}`);
      const [content, truncated] = truncateWithMarker(lines.join("\n"), MAX_BODY_CHARS);
      return {
        content,
        meta: { card: "posthog", kind: "insight", id: body["id"] ?? null, insight_kind: kind, truncated },
      };
    }
    case "list_dashboards": {
      const limit = clampNumber(args, "limit", 20, 100);
      const body = await posthogJson(config, secrets, projectPath(config, `/dashboards/?limit=${limit}`));
      const rows = listOf(body);
      if (rows.length === 0) {
        return { content: "No dashboards.", meta: { card: "posthog", kind: "dashboards", count: 0 } };
      }
      const content = rows
        .map((d) => {
          const description = text(d["description"]);
          const tail = description === "" ? "" : ` — ${excerpt(description, 80)}`;
          return `${text(d["name"]) || "(untitled)"} | id=${text(d["id"])}${tail}`;
        })
        .join("\n");
      return { content, meta: { card: "posthog", kind: "dashboards", count: rows.length } };
    }
    case "get_dashboard": {
      const id = args["id"];
      const ref = typeof id === "number" ? String(id) : typeof id === "string" ? id.trim() : "";
      if (ref === "") throw new Error("get_dashboard requires id");
      const body = await posthogJson(
        config,
        secrets,
        projectPath(config, `/dashboards/${encodeURIComponent(ref)}/`),
      );
      const tiles = Array.isArray(body["tiles"]) ? (body["tiles"] as JsonObject[]) : [];
      const lines = [`${text(body["name"]) || "(untitled)"} (id=${text(body["id"])})`];
      const description = text(body["description"]);
      if (description !== "") lines.push(`description: ${description}`);
      const insights: string[] = [];
      let notes = 0;
      for (const tile of tiles) {
        const insight = (tile["insight"] ?? null) as JsonObject | null;
        if (insight !== null && typeof insight === "object") {
          const name = text(insight["name"]) || text(insight["derived_name"]) || "(unnamed)";
          insights.push(`- ${name} | id=${text(insight["id"])} | short_id=${text(insight["short_id"])}`);
        } else if (tile["text"] !== null && tile["text"] !== undefined) {
          notes += 1;
        }
      }
      lines.push(`insights (${insights.length}):`, insights.length === 0 ? "(none)" : insights.join("\n"));
      if (notes > 0) lines.push(`text tiles: ${notes}`);
      const [content, truncated] = truncateWithMarker(lines.join("\n"), MAX_BODY_CHARS);
      return {
        content,
        meta: { card: "posthog", kind: "dashboard", id: body["id"] ?? null, insights: insights.length, truncated },
      };
    }
    case "list_feature_flags": {
      const limit = clampNumber(args, "limit", 20, 100);
      const body = await posthogJson(config, secrets, projectPath(config, `/feature_flags/?limit=${limit}`));
      const rows = listOf(body);
      if (rows.length === 0) {
        return { content: "No feature flags.", meta: { card: "posthog", kind: "flags", count: 0 } };
      }
      const content = rows
        .map((f) => {
          const active = f["active"] === true ? "active" : "off";
          return `${text(f["key"])} | ${active} | rollout=${rolloutOf(f)} | ${text(f["name"]) || "(unnamed)"}`;
        })
        .join("\n");
      return { content, meta: { card: "posthog", kind: "flags", count: rows.length } };
    }
    case "search_persons": {
      const limit = clampNumber(args, "limit", 10, 50);
      const search = typeof args["search"] === "string" ? (args["search"] as string).trim() : "";
      const suffix = `/persons/?limit=${limit}${search === "" ? "" : `&search=${encodeURIComponent(search)}`}`;
      const body = await posthogJson(config, secrets, projectPath(config, suffix));
      const rows = listOf(body);
      if (rows.length === 0) {
        return { content: "No persons.", meta: { card: "posthog", kind: "persons", count: 0 } };
      }
      const content = rows
        .map((p) => {
          const properties = (p["properties"] ?? {}) as JsonObject;
          const email = text(properties["email"]);
          const distinctIds = Array.isArray(p["distinct_ids"]) ? (p["distinct_ids"] as unknown[]).map(text) : [];
          const head = email !== "" ? email : distinctIds[0] ?? text(p["uuid"]);
          const identified = p["is_identified"] === true ? "identified" : "anonymous";
          return `${head} | ${identified} | last_seen=${text(p["last_seen_at"]) || "-"} | uuid=${text(p["uuid"])}`;
        })
        .join("\n");
      return { content, meta: { card: "posthog", kind: "persons", count: rows.length } };
    }
    case "api":
      return callVendorApi(
        posthogBase(config),
        { kind: "bearer", token: apiKey(secrets) },
        args,
        VENDOR_API_MAX_CHARS,
        [],
      );
    default:
      throw new Error(`posthog integration has no tool ${tool}`);
  }
}
