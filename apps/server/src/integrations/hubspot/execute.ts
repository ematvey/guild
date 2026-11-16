import {
  LIST_TIMEOUT_MS,
  VENDOR_API_MAX_CHARS,
  secretOrNull,
  pathSegment,
  requestJson,
  clampNumber,
  callVendorApi,
  hubspotBaseUrl,
  type JsonRequestErrors,
} from "../shared.js";
import type { ToolOutcome, JsonObject } from "../shared.js";

// ---------- hubspot ----------
//
// One handler per tool, split by what the call can do: the read handlers are
// the `read`-class tools, the write handlers the `write`-class ones, and the
// raw `api` tool stays for the endpoints neither covers.

const HUBSPOT_ERRORS: JsonRequestErrors = {
  unreachable: (cause) => `hubspot unreachable: ${cause}`,
  unreadable: () => "hubspot returned bad json",
  status: (status) => `hubspot returned ${status}`,
  badJson: () => "hubspot returned bad json",
};

/** Properties requested per object type when the call names none (the read
 *  API returns only what the request names). An object type with no entry
 *  here has no default: its properties are the org's own. */
const DISPLAY_PROPS: Record<string, string[]> = {
  contacts: ["firstname", "lastname", "email"],
  companies: ["name", "domain"],
  deals: ["dealname", "amount", "dealstage"],
  tickets: ["subject", "hs_ticket_priority", "hs_pipeline_stage"],
};

function displayProps(object: string): string[] {
  return DISPLAY_PROPS[object] ?? [];
}

/** The report families of the legacy Analytics API
 *  (`/analytics/v2/reports/{report}/{period}`): hosted content, session
 *  breakdowns, and object engagement. The three documentation pages share
 *  one parameter set, so one tool names all of them. */
export const ANALYTICS_REPORTS = [
  "totals",
  "sessions",
  "sources",
  "geolocation",
  "utm-campaigns",
  "utm-contents",
  "utm-mediums",
  "utm-sources",
  "utm-terms",
  "landing-pages",
  "standard-pages",
  "blog-posts",
  "listing-pages",
  "knowledge-articles",
  "pages",
  "forms",
  "event-completions",
  "social-assists",
] as const;

/** How an analytics report groups the range. `summarize/*` returns the same
 *  rows plus a summary row per bucket. */
export const ANALYTICS_PERIODS = [
  "total",
  "daily",
  "weekly",
  "monthly",
  "summarize/daily",
  "summarize/weekly",
  "summarize/monthly",
] as const;

/** An object type as a request path segment: HubSpot's ids are letters,
 *  digits, `_` and `-` (`p148247336_subscriptions`, `2-12345`). */
function objectSegment(value: unknown, tool: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) {
    throw new Error(`${tool} requires object_type`);
  }
  return pathSegment(value);
}

/** The string list one array argument holds, or null when it is not one. */
function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every((item) => typeof item === "string") ? (value as string[]) : null;
}

/** One value the call names, checked against the fixed list the tool
 *  declares: the report and period reach the request path. */
function oneOf(value: unknown, allowed: readonly string[], name: string, tool: string): string {
  if (typeof value === "string" && allowed.includes(value)) return value;
  throw new Error(`${tool} requires ${name}: one of ${allowed.join(", ")}`);
}

/** A range bound as HubSpot reads it: eight digits, YYYYMMDD. */
function dayArg(value: unknown, name: string, tool: string): string {
  if (typeof value !== "string" || !/^\d{8}$/.test(value)) {
    throw new Error(`${tool} requires ${name} as YYYYMMDD`);
  }
  return value;
}

function recordId(value: unknown, tool: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`${tool} requires id`);
  return pathSegment(value);
}

function propertiesArg(value: unknown, tool: string): JsonObject {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0) {
    throw new Error(`${tool} requires a non-empty properties object`);
  }
  return value as JsonObject;
}

/** One JSON request against the CRM, with the bearer token and the bounded
 *  body read. */
function crm(
  base: string,
  token: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body?: JsonObject,
): Promise<JsonObject> {
  return requestJson(
    `${base}${path}`,
    {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
    LIST_TIMEOUT_MS,
    HUBSPOT_ERRORS,
    // DELETE answers 204: no body to parse.
    method === "DELETE" ? { emptyBody: {} } : {},
  );
}

/** The one-line label of a record: its id and the named properties that are
 *  set. */
function recordLabel(properties: string[], hit: JsonObject): string {
  const id = typeof hit["id"] === "string" ? hit["id"] : "?";
  const props = (hit["properties"] ?? {}) as JsonObject;
  const values = properties
    .map((p) => (typeof props[p] === "string" && props[p] !== "" ? `${p}=${props[p]}` : null))
    .filter((v): v is string => v !== null)
    .slice(0, 4);
  return `id=${id}${values.length === 0 ? "" : ` ${values.join(" ")}`}`;
}

// ---------- read ----------

/** One CRM v3 search: free text, property filters, the properties to return,
 *  sorting and one page. It cannot change a record. */
async function hubspotSearch(base: string, token: string, args: JsonObject, named?: string): Promise<ToolOutcome> {
  const object = named ?? objectSegment(args["object_type"], "search_objects");
  const query = args["query"];
  if (query !== undefined && typeof query !== "string") throw new Error("query must be a string");
  const filterGroups = args["filterGroups"];
  if (filterGroups !== undefined && !Array.isArray(filterGroups)) throw new Error("filterGroups must be a list");
  const sorts = args["sorts"];
  if (sorts !== undefined && !Array.isArray(sorts)) throw new Error("sorts must be a list");
  const limit = clampNumber(args, "limit", 10, 100);
  const properties = stringList(args["properties"]) ?? displayProps(object);
  const after = typeof args["after"] === "string" && args["after"] !== "" ? args["after"] : null;
  const body: JsonObject = { limit, properties };
  if (typeof query === "string" && query !== "") body["query"] = query;
  if (Array.isArray(filterGroups) && filterGroups.length > 0) body["filterGroups"] = filterGroups;
  if (Array.isArray(sorts) && sorts.length > 0) body["sorts"] = sorts;
  if (after !== null) body["after"] = after;
  const parsed = await crm(base, token, "POST", `/crm/v3/objects/${pathSegment(object)}/search`, body);
  const hits = Array.isArray(parsed["results"]) ? (parsed["results"] as JsonObject[]) : [];
  let content = "";
  const results: JsonObject[] = [];
  for (const [i, hit] of hits.slice(0, limit).entries()) {
    const label = `${i + 1}. ${recordLabel(properties, hit)}`;
    content += `${label}\n`;
    results.push({ id: hit["id"] ?? null, label });
  }
  if (content === "") content = "No results.";
  const paging = parsed["paging"] as JsonObject | undefined;
  const next = typeof paging?.["next"] === "object" ? (paging["next"] as JsonObject)["after"] : undefined;
  const cursor = typeof next === "string" ? next : null;
  if (cursor !== null) content += `More results: call again with after="${cursor}".\n`;
  const total = typeof parsed["total"] === "number" ? parsed["total"] : null;
  return {
    content,
    meta: { card: "crm", kind: "search", object, count: results.length, total, after: cursor, results },
  };
}

/** One record by id, with the properties it names and the associations it
 *  asks for. */
async function hubspotGetObject(base: string, token: string, args: JsonObject): Promise<ToolOutcome> {
  const object = objectSegment(args["object_type"], "get_object");
  const id = recordId(args["id"], "get_object");
  const properties = stringList(args["properties"]);
  const associations = stringList(args["associations"]);
  const params: string[] = [];
  if (properties !== null) params.push(`properties=${properties.map(encodeURIComponent).join(",")}`);
  if (associations !== null) params.push(`associations=${associations.map(encodeURIComponent).join(",")}`);
  const query = params.length === 0 ? "" : `?${params.join("&")}`;
  const parsed = await crm(base, token, "GET", `/crm/v3/objects/${object}/${id}${query}`);
  const shown = properties ?? displayProps(object);
  const label = recordLabel(shown, parsed);
  const props = (parsed["properties"] ?? {}) as JsonObject;
  const lines = [`${object} ${label}`];
  for (const [key, value] of Object.entries(props)) {
    if (value !== null && value !== "" && typeof value !== "object") lines.push(`  ${key}: ${String(value)}`);
  }
  const associationsOut = (parsed["associations"] ?? null) as JsonObject | null;
  if (associationsOut !== null) lines.push(`  associations: ${JSON.stringify(associationsOut)}`);
  return {
    content: lines.join("\n"),
    meta: { card: "crm", kind: "record", object, id, properties: props, associations: associationsOut },
  };
}

/** Up to 100 records by id in one call. */
async function hubspotBatchRead(base: string, token: string, args: JsonObject): Promise<ToolOutcome> {
  const object = objectSegment(args["object_type"], "batch_read");
  const ids = stringList(args["ids"]);
  if (ids === null) throw new Error("batch_read requires ids");
  if (ids.length > 100) throw new Error("batch_read takes at most 100 ids");
  const properties = stringList(args["properties"]) ?? displayProps(object);
  const parsed = await crm(base, token, "POST", `/crm/v3/objects/${object}/batch/read`, {
    properties,
    inputs: ids.map((id) => ({ id })),
  });
  const hits = Array.isArray(parsed["results"]) ? (parsed["results"] as JsonObject[]) : [];
  let content = "";
  const results: JsonObject[] = [];
  for (const [i, hit] of hits.entries()) {
    const label = `${i + 1}. ${recordLabel(properties, hit)}`;
    content += `${label}\n`;
    results.push({ id: hit["id"] ?? null, label });
  }
  const missing = ids.filter((id) => !results.some((row) => row["id"] === id));
  if (content === "") content = "No records.";
  if (missing.length > 0) content += `Not found: ${missing.join(", ")}.\n`;
  return { content, meta: { card: "crm", kind: "search", object, count: results.length, results } };
}

/** The record ids on the other end of one record's association. */
async function hubspotAssociations(base: string, token: string, args: JsonObject): Promise<ToolOutcome> {
  const object = objectSegment(args["object_type"], "get_associations");
  const id = recordId(args["id"], "get_associations");
  const to = objectSegment(args["to_object_type"], "get_associations");
  const parsed = await crm(base, token, "GET", `/crm/v3/objects/${object}/${id}/associations/${to}`);
  const rows = Array.isArray(parsed["results"]) ? (parsed["results"] as JsonObject[]) : [];
  const ids = rows.map((row) => (typeof row["toObjectId"] === "string" ? row["toObjectId"] : null));
  const related = ids.filter((v): v is string => v !== null);
  const content = related.length === 0 ? `No associated ${to}.` : `${to}: ${related.join(", ")}`;
  return { content, meta: { card: "crm", kind: "associations", object, id, to, ids: related } };
}

/** The org's owners, so an owner id can be read as a name. */
async function hubspotOwners(base: string, token: string, args: JsonObject): Promise<ToolOutcome> {
  const limit = clampNumber(args, "limit", 50, 100);
  const after = typeof args["after"] === "string" && args["after"] !== "" ? args["after"] : null;
  const query = `?limit=${limit}${after === null ? "" : `&after=${encodeURIComponent(after)}`}`;
  const parsed = await crm(base, token, "GET", `/crm/v3/owners${query}`);
  const rows = Array.isArray(parsed["results"]) ? (parsed["results"] as JsonObject[]) : [];
  const owners = rows.map((row) => ({
    id: typeof row["id"] === "string" ? row["id"] : null,
    email: typeof row["email"] === "string" ? row["email"] : null,
    name: [row["firstName"], row["lastName"]].filter((v) => typeof v === "string" && v !== "").join(" ") || null,
  }));
  let content = owners.map((o, i) => `${i + 1}. id=${o.id ?? "?"} ${o.name ?? ""} ${o.email ?? ""}`.trim()).join("\n");
  if (content === "") content = "No owners.";
  const paging = parsed["paging"] as JsonObject | undefined;
  const next = typeof paging?.["next"] === "object" ? (paging["next"] as JsonObject)["after"] : undefined;
  const cursor = typeof next === "string" ? next : null;
  if (cursor !== null) content += `\nMore owners: call again with after="${cursor}".`;
  return { content, meta: { card: "crm", kind: "owners", count: owners.length, after: cursor, owners } };
}

/** One object type's property schema: the names a filter can use, and the
 *  values an enum property accepts. */
async function hubspotProperties(base: string, token: string, args: JsonObject): Promise<ToolOutcome> {
  const object = objectSegment(args["object_type"], "list_properties");
  const parsed = await crm(base, token, "GET", `/crm/v3/properties/${object}`);
  const rows = Array.isArray(parsed["results"]) ? (parsed["results"] as JsonObject[]) : [];
  const wanted = typeof args["query"] === "string" ? args["query"].toLowerCase() : null;
  const properties = rows
    .map((row) => ({
      name: typeof row["name"] === "string" ? row["name"] : "",
      label: typeof row["label"] === "string" ? row["label"] : "",
      type: typeof row["type"] === "string" ? row["type"] : "",
      fieldType: typeof row["fieldType"] === "string" ? row["fieldType"] : "",
      options: Array.isArray(row["options"])
        ? (row["options"] as JsonObject[]).map((o) => (typeof o["value"] === "string" ? o["value"] : "")).slice(0, 20)
        : [],
    }))
    .filter(
      (p) =>
        p.name !== "" &&
        (wanted === null || p.name.toLowerCase().includes(wanted) || p.label.toLowerCase().includes(wanted)),
    );
  let content = properties
    .map(
      (p) =>
        `${p.name} (${p.label}) ${p.type}/${p.fieldType}${p.options.length === 0 ? "" : ` [${p.options.join(" | ")}]`}`,
    )
    .join("\n");
  if (content === "") content = "No matching properties.";
  return { content, meta: { card: "crm", kind: "properties", object, count: properties.length } };
}

/** The pipelines and stages of one object type: the stage ids a filter
 *  needs. */
async function hubspotPipelines(base: string, token: string, args: JsonObject): Promise<ToolOutcome> {
  const object = objectSegment(args["object_type"], "list_pipelines");
  const parsed = await crm(base, token, "GET", `/crm/v3/pipelines/${object}`);
  const rows = Array.isArray(parsed["results"]) ? (parsed["results"] as JsonObject[]) : [];
  const pipelines = rows.map((row) => ({
    id: typeof row["id"] === "string" ? row["id"] : "",
    label: typeof row["label"] === "string" ? row["label"] : "",
    stages: Array.isArray(row["stages"])
      ? (row["stages"] as JsonObject[]).map((s) => ({
          id: typeof s["id"] === "string" ? s["id"] : "",
          label: typeof s["label"] === "string" ? s["label"] : "",
        }))
      : [],
  }));
  let content = pipelines
    .map((p) => `${p.label} (${p.id}): ${p.stages.map((s) => `${s.label}=${s.id}`).join(", ")}`)
    .join("\n");
  if (content === "") content = "No pipelines.";
  return { content, meta: { card: "crm", kind: "pipelines", object, count: pipelines.length } };
}

// ---------- analytics ----------

/** One metric row as `key=value` pairs; the row's own label is printed by
 *  the caller. */
function metrics(row: JsonObject): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(row)) {
    if (key === "breakdown") continue;
    if (typeof value === "number") parts.push(`${key}=${value}`);
    else if (typeof value === "string" && value !== "") parts.push(`${key}=${value}`);
  }
  return parts.join(" ");
}

/** One legacy Analytics API report: the range totals plus one row per
 *  breakdown value, paged by offset. */
async function hubspotAnalytics(base: string, token: string, args: JsonObject): Promise<ToolOutcome> {
  const report = oneOf(args["report"], ANALYTICS_REPORTS, "report", "get_analytics");
  const period = oneOf(args["period"], ANALYTICS_PERIODS, "period", "get_analytics");
  const start = dayArg(args["start"], "start", "get_analytics");
  const end = dayArg(args["end"], "end", "get_analytics");
  const params = new URLSearchParams({ start, end });
  const drilldown = stringList(args["drilldown"]);
  if (drilldown !== null) {
    params.set("d1", drilldown[0]);
    if (drilldown[1] !== undefined) params.set("d2", drilldown[1]);
  }
  for (const value of stringList(args["filter"]) ?? []) params.append("f", value);
  for (const value of stringList(args["exclude"]) ?? []) params.append("e", value);
  const view = args["view_id"];
  if (typeof view === "number" && Number.isFinite(view)) params.set("filterId", String(Math.trunc(view)));
  if (typeof args["sort"] === "string" && args["sort"] !== "") params.set("sort", args["sort"]);
  const dir = args["sort_dir"];
  if (dir === "ASC" || dir === "DESC") params.set("sortDir", dir);
  const limit = clampNumber(args, "limit", 25, 350);
  params.set("limit", String(limit));
  const offset = typeof args["offset"] === "number" && Number.isFinite(args["offset"])
    ? Math.max(0, Math.trunc(args["offset"]))
    : 0;
  if (offset > 0) params.set("offset", String(offset));
  // `summarize/daily` is two path segments in HubSpot's own route.
  const periodPath = period.split("/").map(pathSegment).join("/");
  const parsed = await crm(
    base,
    token,
    "GET",
    `/analytics/v2/reports/${pathSegment(report)}/${periodPath}?${params.toString()}`,
  );
  const totals = (parsed["totals"] ?? {}) as JsonObject;
  const raw = parsed["breakdowns"];
  const rows = Array.isArray(raw) ? (raw as JsonObject[]) : [];
  const total = typeof parsed["total"] === "number" ? parsed["total"] : rows.length;
  const lines = [`${report}/${period} ${start}-${end}: ${rows.length} of ${total} rows`];
  const totalsLine = metrics(totals);
  if (totalsLine !== "") lines.push(`totals: ${totalsLine}`);
  for (const [i, row] of rows.slice(0, limit).entries()) {
    const label = typeof row["breakdown"] === "string" && row["breakdown"] !== "" ? row["breakdown"] : `row ${offset + i + 1}`;
    lines.push(`${i + 1}. ${label}: ${metrics(row)}`);
  }
  if (rows.length === 0) lines.push("No rows for this report and range.");
  const next = offset + rows.length;
  if (total > next) lines.push(`More rows: call again with offset=${next}.`);
  return {
    content: lines.join("\n"),
    meta: { card: "crm", kind: "analytics", report, period, start, end, total, offset },
  };
}

/** The org's saved Analytics views: the id `get_analytics` takes as
 *  `view_id`, and the filters each view holds. */
async function hubspotAnalyticsViews(base: string, token: string): Promise<ToolOutcome> {
  const parsed = await crm(base, token, "GET", "/analytics/v2/views");
  const raw: unknown = parsed;
  const rows = Array.isArray(raw)
    ? (raw as JsonObject[])
    : Array.isArray(parsed["results"])
      ? (parsed["results"] as JsonObject[])
      : [];
  const views = rows.map((row) => ({
    id: typeof row["id"] === "number" ? row["id"] : null,
    title: typeof row["title"] === "string" ? row["title"] : "",
    filters: Array.isArray(row["reportPropertyFilters"]) ? (row["reportPropertyFilters"] as JsonObject[]).length : 0,
  }));
  let content = views
    .map((v, i) => `${i + 1}. id=${v.id ?? "?"} "${v.title}"${v.filters === 0 ? "" : ` filters=${v.filters}`}`)
    .join("\n");
  if (content === "") content = "No saved Analytics views.";
  return { content, meta: { card: "crm", kind: "analytics", views: views.length } };
}

/** Whether HubSpot tracks analytics for one object type. */
async function hubspotAnalyticsExists(base: string, token: string, args: JsonObject): Promise<ToolOutcome> {
  const object = objectSegment(args["object_type"], "analytics_exists");
  const parsed = await crm(base, token, "GET", `/analytics/v2/reports/${object}/exists`);
  const exists = parsed["exists"] === true;
  return {
    content: exists
      ? `${object}: HubSpot has analytics data for this object type.`
      : `${object}: no analytics data for this object type.`,
    meta: { card: "crm", kind: "analytics", object, exists },
  };
}

// ---------- write ----------

async function hubspotCreate(base: string, token: string, args: JsonObject): Promise<ToolOutcome> {
  const object = objectSegment(args["object_type"], "create_object");
  const properties = propertiesArg(args["properties"], "create_object");
  const parsed = await crm(base, token, "POST", `/crm/v3/objects/${object}`, { properties });
  const id = typeof parsed["id"] === "string" ? parsed["id"] : null;
  return {
    content: `${object} ${id ?? "?"} created (${Object.keys(properties).join(", ")}).`,
    meta: { card: "crm", kind: "create", object, id, fields: Object.keys(properties) },
  };
}

async function hubspotUpdate(base: string, token: string, args: JsonObject): Promise<ToolOutcome> {
  const object = objectSegment(args["object_type"], "update_object");
  const id = recordId(args["id"], "update_object");
  const properties = propertiesArg(args["properties"], "update_object");
  const parsed = await crm(base, token, "PATCH", `/crm/v3/objects/${object}/${id}`, { properties });
  const updatedId = typeof parsed["id"] === "string" ? parsed["id"] : id;
  return {
    content: `${object} ${updatedId} updated (${Object.keys(properties).join(", ")}).`,
    meta: { card: "crm", kind: "update", object, id: updatedId, fields: Object.keys(properties) },
  };
}

async function hubspotDelete(base: string, token: string, args: JsonObject): Promise<ToolOutcome> {
  const object = objectSegment(args["object_type"], "delete_object");
  const id = recordId(args["id"], "delete_object");
  await crm(base, token, "DELETE", `/crm/v3/objects/${object}/${id}`);
  return {
    content: `${object} ${id} deleted.`,
    meta: { card: "crm", kind: "delete", object, id },
  };
}

// ---------- dispatch ----------

/** The tools whose object type the tool name fixes. */
const NAMED_SEARCH: Record<string, string> = {
  search_contacts: "contacts",
  search_companies: "companies",
  search_deals: "deals",
  search_tickets: "tickets",
};

export async function hubspotExecute(
  config: JsonObject,
  tool: string,
  args: JsonObject,
  secrets: [string, string][],
  _actingAs: string | null,
): Promise<ToolOutcome> {
  const token = secretOrNull(secrets, "token");
  if (token === null) throw new Error("hubspot requires the token secret");
  const base = hubspotBaseUrl(config);
  const named = NAMED_SEARCH[tool];
  if (named !== undefined) return hubspotSearch(base, token, args, named);
  switch (tool) {
    case "api":
      return callVendorApi(base, { kind: "bearer", token }, args, VENDOR_API_MAX_CHARS, []);
    case "search_objects":
      return hubspotSearch(base, token, args);
    case "get_object":
      return hubspotGetObject(base, token, args);
    case "batch_read":
      return hubspotBatchRead(base, token, args);
    case "get_associations":
      return hubspotAssociations(base, token, args);
    case "list_owners":
      return hubspotOwners(base, token, args);
    case "list_properties":
      return hubspotProperties(base, token, args);
    case "list_pipelines":
      return hubspotPipelines(base, token, args);
    case "get_analytics":
      return hubspotAnalytics(base, token, args);
    case "list_analytics_views":
      return hubspotAnalyticsViews(base, token);
    case "analytics_exists":
      return hubspotAnalyticsExists(base, token, args);
    case "create_object":
      return hubspotCreate(base, token, args);
    case "update_object":
      return hubspotUpdate(base, token, args);
    case "delete_object":
      return hubspotDelete(base, token, args);
    default:
      throw new Error(`hubspot integration has no tool ${tool}`);
  }
}
