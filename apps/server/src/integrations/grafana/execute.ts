// Grafana: metrics through a Prometheus datasource, logs through Loki,
// dashboards, datasources, and the active alert list. Every call names its
// datasource: a wrong region is a wrong answer, so the tool reports the
// datasource it used.

import { CALL_TIMEOUT_MS, MAX_BODY_CHARS, clampNumber, excerpt, requestJson, truncateWithMarker } from "../shared.js";
import type { ToolOutcome, JsonObject } from "../shared.js";

function grafanaBase(config: JsonObject): string {
  const raw = config["base_url"];
  if (typeof raw !== "string" || raw.trim() === "") throw new Error("grafana config requires base_url");
  return raw.replace(/\/+$/, "");
}

function grafanaToken(secrets: [string, string][]): string {
  const found = secrets.find(([name]) => name === "token");
  if (found === undefined || found[1] === "") throw new Error("grafana requires the token secret");
  return found[1];
}

function orgId(config: JsonObject): number {
  const raw = config["org_id"];
  return typeof raw === "number" && Number.isFinite(raw) ? Math.trunc(raw) : 1;
}

/** One JSON request against the Grafana API. */
async function grafanaJson(
  config: JsonObject,
  secrets: [string, string][],
  path: string,
  init: RequestInit = {},
): Promise<JsonObject> {
  const url = `${grafanaBase(config)}${path}`;
  const headers: Record<string, string> = {
    authorization: `Bearer ${grafanaToken(secrets)}`,
    "x-grafana-org-id": String(orgId(config)),
    accept: "application/json",
  };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  return requestJson(
    url,
    { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } },
    CALL_TIMEOUT_MS,
    {
      unreachable: (cause) => `grafana unreachable: ${cause}`,
      unreadable: (cause) => `grafana unreachable: ${cause}`,
      status: (status, text) => `grafana ${status} on ${path}: ${excerpt(text, 300)}`,
      badJson: (text) => `grafana returned a non-JSON body on ${path}: ${excerpt(text, 200)}`,
    },
    { emptyBody: {} },
  );
}

/** Resolves a datasource reference — a uid or a name — to its uid and type. */
async function resolveDatasource(
  config: JsonObject,
  secrets: [string, string][],
  reference: string,
): Promise<{ uid: string; name: string; type: string }> {
  const tried: string[] = [];
  for (const path of [`/api/datasources/uid/${encodeURIComponent(reference)}`, `/api/datasources/name/${encodeURIComponent(reference)}`]) {
    try {
      const body = await grafanaJson(config, secrets, path);
      const uid = body["uid"];
      const name = body["name"];
      const type = body["type"];
      if (typeof uid === "string" && typeof name === "string" && typeof type === "string") {
        return { uid, name, type };
      }
    } catch (error) {
      tried.push((error as Error).message);
    }
  }
  throw new Error(`grafana datasource "${reference}" not found (${tried.join("; ")})`);
}

function defaultDatasource(config: JsonObject, kind: "prometheus" | "loki"): string {
  const key = kind === "prometheus" ? "prometheus_datasource" : "loki_datasource";
  const fallback = kind === "prometheus" ? "Prometheus" : "Loki";
  const raw = config[key];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : fallback;
}

function timeArg(args: JsonObject, name: string, fallback: string): string {
  const raw = args[name];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : fallback;
}

/** Prometheus answer -> one line per series, value or step count. */
function prometheusLines(body: JsonObject, maxSeries: number): { text: string; series: number } {
  const data = (body["data"] ?? {}) as JsonObject;
  const result = Array.isArray(data["result"]) ? (data["result"] as JsonObject[]) : [];
  const resultType = typeof data["resultType"] === "string" ? data["resultType"] : "vector";
  if (result.length === 0) return { text: "No series.", series: 0 };
  let text = `resultType=${resultType}\n`;
  for (const [i, series] of result.slice(0, maxSeries).entries()) {
    const metric = (series["metric"] ?? {}) as JsonObject;
    const labels = Object.entries(metric)
      .map(([k, v]) => `${k}="${String(v)}"`)
      .join(" ");
    if (resultType === "matrix" && Array.isArray(series["values"])) {
      const values = series["values"] as unknown[][];
      const last = values[values.length - 1];
      text += `${i + 1}. {${labels}} points=${values.length} last=${last ? String(last[1]) : "?"}\n`;
    } else {
      const value = series["value"];
      text += `${i + 1}. {${labels}} ${Array.isArray(value) ? String(value[1]) : "?"}\n`;
    }
  }
  if (result.length > maxSeries) text += `(${result.length - maxSeries} more series)\n`;
  return { text, series: result.length };
}

export async function grafanaExecute(
  config: JsonObject,
  tool: string,
  args: JsonObject,
  secrets: [string, string][],
  _actingAs: string | null,
): Promise<ToolOutcome> {
  switch (tool) {
    case "query_metrics": {
      const query = args["query"];
      if (typeof query !== "string" || query.trim() === "") throw new Error("query_metrics requires query");
      const reference = typeof args["datasource"] === "string" && args["datasource"].trim() !== ""
        ? (args["datasource"] as string).trim()
        : defaultDatasource(config, "prometheus");
      const ds = await resolveDatasource(config, secrets, reference);
      if (ds.type !== "prometheus") {
        throw new Error(`datasource "${ds.name}" is ${ds.type}, not prometheus`);
      }
      const start = typeof args["start"] === "string" ? (args["start"] as string) : undefined;
      const end = typeof args["end"] === "string" ? (args["end"] as string) : undefined;
      const step = typeof args["step"] === "string" ? (args["step"] as string) : "60s";
      const range = start !== undefined || end !== undefined;
      const path = range
        ? `/api/datasources/uid/${ds.uid}/resources/api/v1/query_range?query=${encodeURIComponent(query)}` +
          `&start=${encodeURIComponent(timeArg(args, "start", "now-1h"))}` +
          `&end=${encodeURIComponent(timeArg(args, "end", "now"))}` +
          `&step=${encodeURIComponent(step)}`
        : `/api/datasources/uid/${ds.uid}/resources/api/v1/query?query=${encodeURIComponent(query)}` +
          (typeof args["time"] === "string" ? `&time=${encodeURIComponent(args["time"] as string)}` : "");
      const body = await grafanaJson(config, secrets, path);
      const lines = prometheusLines(body, clampNumber(args, "max_series", 20, 100));
      return {
        content: `datasource=${ds.name} (${ds.uid})\n${lines.text}`,
        meta: { card: "grafana", kind: "metrics", datasource: ds.name, series: lines.series },
      };
    }
    case "query_logs": {
      const query = args["query"];
      if (typeof query !== "string" || query.trim() === "") throw new Error("query_logs requires query");
      const reference = typeof args["datasource"] === "string" && args["datasource"].trim() !== ""
        ? (args["datasource"] as string).trim()
        : defaultDatasource(config, "loki");
      const ds = await resolveDatasource(config, secrets, reference);
      if (ds.type !== "loki") throw new Error(`datasource "${ds.name}" is ${ds.type}, not loki`);
      const limit = clampNumber(args, "limit", 100, 500);
      const startNs = String(Date.parse(timeArg(args, "start", "now-15m")) * 1_000_000);
      const endNs = String(Date.parse(timeArg(args, "end", "now")) * 1_000_000);
      const path =
        `/api/datasources/proxy/uid/${ds.uid}/loki/api/v1/query_range?query=${encodeURIComponent(query)}` +
        `&start=${encodeURIComponent(startNs)}&end=${encodeURIComponent(endNs)}` +
        `&limit=${limit}&direction=backward`;
      const body = await grafanaJson(config, secrets, path);
      const data = (body["data"] ?? {}) as JsonObject;
      const streams = Array.isArray(data["result"]) ? (data["result"] as JsonObject[]) : [];
      let out = `datasource=${ds.name} (${ds.uid})\n`;
      let count = 0;
      for (const stream of streams) {
        const labels = Object.entries((stream["stream"] ?? {}) as JsonObject)
          .map(([k, v]) => `${k}="${String(v)}"`)
          .join(" ");
        const values = Array.isArray(stream["values"]) ? (stream["values"] as unknown[][]) : [];
        for (const pair of values) {
          if (count >= limit) break;
          const ts = typeof pair[0] === "string" ? new Date(Number(BigInt(pair[0]) / 1_000_000n)).toISOString() : "?";
          out += `${ts} {${labels}} ${String(pair[1]).trim()}\n`;
          count += 1;
        }
      }
      if (count === 0) out += "No log lines.\n";
      const [content, truncated] = truncateWithMarker(out, MAX_BODY_CHARS);
      return {
        content,
        meta: { card: "grafana", kind: "logs", datasource: ds.name, lines: count, truncated },
      };
    }
    case "list_datasources": {
      const type = typeof args["type"] === "string" ? (args["type"] as string) : null;
      const body = await grafanaJson(config, secrets, "/api/datasources");
      const list = Array.isArray(body) ? (body as JsonObject[]) : [];
      const rows = list.filter((d) => type === null || d["type"] === type);
      if (rows.length === 0) return { content: "No datasources.", meta: { card: "grafana", kind: "datasources", count: 0 } };
      const content = rows
        .map((d) => `${String(d["name"])} | ${String(d["type"])} | uid=${String(d["uid"])}`)
        .join("\n");
      return { content, meta: { card: "grafana", kind: "datasources", count: rows.length } };
    }
    case "list_dashboards": {
      const limit = clampNumber(args, "limit", 20, 100);
      const query = typeof args["query"] === "string" ? (args["query"] as string) : "";
      const path =
        `/api/search?type=dash-db&limit=${limit}` +
        (query === "" ? "" : `&query=${encodeURIComponent(query)}`);
      const body = await grafanaJson(config, secrets, path);
      const list = Array.isArray(body) ? (body as JsonObject[]) : [];
      if (list.length === 0) return { content: "No dashboards.", meta: { card: "grafana", kind: "dashboards", count: 0 } };
      const content = list
        .map((d) => {
          const folder = typeof d["folderTitle"] === "string" && d["folderTitle"] !== "" ? ` [${d["folderTitle"]}]` : "";
          return `${String(d["title"])}${folder} uid=${String(d["uid"])}`;
        })
        .join("\n");
      return { content, meta: { card: "grafana", kind: "dashboards", count: list.length } };
    }
    case "get_dashboard": {
      const uid = args["uid"];
      if (typeof uid !== "string" || uid === "") throw new Error("get_dashboard requires uid");
      const body = await grafanaJson(config, secrets, `/api/dashboards/uid/${encodeURIComponent(uid)}`);
      const dashboard = (body["dashboard"] ?? {}) as JsonObject;
      const panels = Array.isArray(dashboard["panels"]) ? (dashboard["panels"] as JsonObject[]) : [];
      const panelLines = panels
        .map((p) => `- ${String(p["title"] ?? "(untitled)")} [${String(p["type"] ?? "?")}]`)
        .join("\n");
      const content =
        `title=${String(dashboard["title"] ?? "?")} uid=${uid}\n` +
        `tags=${Array.isArray(dashboard["tags"]) ? (dashboard["tags"] as string[]).join(", ") : ""}\n` +
        `panels:\n${panelLines === "" ? "(none)" : panelLines}`;
      return { content, meta: { card: "grafana", kind: "dashboard", uid, panels: panels.length } };
    }
    case "list_alerts": {
      const body = await grafanaJson(config, secrets, "/api/alertmanager/grafana/api/v2/alerts");
      const list = Array.isArray(body) ? (body as JsonObject[]) : [];
      if (list.length === 0) return { content: "No active alerts.", meta: { card: "grafana", kind: "alerts", count: 0 } };
      const content = list
        .map((a) => {
          const labels = (a["labels"] ?? {}) as JsonObject;
          const annotations = (a["annotations"] ?? {}) as JsonObject;
          const name = String(labels["alertname"] ?? "?");
          const severity = String(labels["severity"] ?? "-");
          const message = String(annotations["summary"] ?? annotations["message"] ?? "");
          const since = String(a["startsAt"] ?? "");
          return `[${severity}] ${name} since ${since}\n  ${message}`;
        })
        .join("\n");
      return { content, meta: { card: "grafana", kind: "alerts", count: list.length } };
    }
    case "api": {
      const path = args["path"];
      if (typeof path !== "string" || !path.startsWith("/")) throw new Error("api requires path starting with /");
      const method = typeof args["method"] === "string" ? (args["method"] as string).toUpperCase() : "GET";
      const query = args["query"];
      let full = path;
      if (query !== null && typeof query === "object" && !Array.isArray(query)) {
        const params = new URLSearchParams();
        for (const [k, v] of Object.entries(query as JsonObject)) params.set(k, String(v));
        const qs = params.toString();
        if (qs !== "") full += `${full.includes("?") ? "&" : "?"}${qs}`;
      }
      const body = args["body"];
      const init: RequestInit = { method };
      if (body !== null && body !== undefined && method !== "GET" && method !== "HEAD") {
        init.body = JSON.stringify(body);
      }
      const json = await grafanaJson(config, secrets, full, init);
      const text = JSON.stringify(json, null, 2);
      const [content, truncated] = truncateWithMarker(text, MAX_BODY_CHARS);
      return { content, meta: { card: "grafana", kind: "api", truncated } };
    }
    default:
      throw new Error(`grafana integration has no tool ${tool}`);
  }
}

export { grafanaBase };
