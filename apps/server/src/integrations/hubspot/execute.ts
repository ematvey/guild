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

/** The search tools and the object type each one searches; `null` means the
 *  call names it (`search_custom`). */
const HUBSPOT_SEARCH_TOOLS: Record<string, string | null> = {
  search_contacts: "contacts",
  search_companies: "companies",
  search_deals: "deals",
  search_tickets: "tickets",
  search_custom: null,
};

/** Properties requested per object type when the call names none (the search
 *  API returns only what the request names). A custom object has no default:
 *  its properties are the org's own, so the call names them. */
function hubspotDisplayProps(object: string): string[] {
  switch (object) {
    case "contacts":
      return ["firstname", "lastname", "email"];
    case "companies":
      return ["name", "domain"];
    case "deals":
      return ["dealname", "amount", "dealstage"];
    case "tickets":
      return ["subject", "hs_ticket_priority", "hs_pipeline_stage"];
    default:
      return [];
  }
}

/** The string list one array argument holds, or null when it is not one. */
function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every((item) => typeof item === "string") ? (value as string[]) : null;
}

function hubspotSearchLine(index: number, properties: string[], hit: JsonObject): string {
  const id = typeof hit["id"] === "string" ? hit["id"] : "?";
  const props = (hit["properties"] ?? {}) as JsonObject;
  const values = properties
    .map((p) => (typeof props[p] === "string" && props[p] !== "" ? `${p}=${props[p]}` : null))
    .filter((v): v is string => v !== null)
    .slice(0, 4);
  return `${index + 1}. id=${id}${values.length === 0 ? "" : ` ${values.join(" ")}`}`;
}

const HUBSPOT_ERRORS: JsonRequestErrors = {
  unreachable: (cause) => `hubspot unreachable: ${cause}`,
  unreadable: () => "hubspot returned bad json",
  status: (status) => `hubspot returned ${status}`,
  badJson: () => "hubspot returned bad json",
};

/** One CRM v3 search: free text, property filters, the properties to return,
 *  sorting and one page. It cannot change a record. */
async function hubspotSearch(object: string, base: string, token: string, args: JsonObject): Promise<ToolOutcome> {
  const query = args["query"];
  if (query !== undefined && typeof query !== "string") throw new Error("query must be a string");
  const filterGroups = args["filterGroups"];
  if (filterGroups !== undefined && !Array.isArray(filterGroups)) throw new Error("filterGroups must be a list");
  const sorts = args["sorts"];
  if (sorts !== undefined && !Array.isArray(sorts)) throw new Error("sorts must be a list");
  const limit = clampNumber(args, "limit", 10, 100);
  const properties = stringList(args["properties"]) ?? hubspotDisplayProps(object);
  const after = typeof args["after"] === "string" && args["after"] !== "" ? args["after"] : null;
  const body: JsonObject = { limit, properties };
  if (typeof query === "string" && query !== "") body["query"] = query;
  if (Array.isArray(filterGroups) && filterGroups.length > 0) body["filterGroups"] = filterGroups;
  if (Array.isArray(sorts) && sorts.length > 0) body["sorts"] = sorts;
  if (after !== null) body["after"] = after;
  const parsed = await requestJson(
    `${base}/crm/v3/objects/${pathSegment(object)}/search`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    LIST_TIMEOUT_MS,
    HUBSPOT_ERRORS,
  );
  const hits = Array.isArray(parsed["results"]) ? (parsed["results"] as JsonObject[]) : [];
  let content = "";
  const results: JsonObject[] = [];
  for (const [i, hit] of hits.slice(0, limit).entries()) {
    const label = hubspotSearchLine(i, properties, hit);
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

async function hubspotUpdateDeal(base: string, token: string, args: JsonObject): Promise<ToolOutcome> {
  const id = args["id"];
  if (typeof id !== "string") throw new Error("update_deal requires id");
  const props = args["properties"];
  if (props === null || typeof props !== "object" || Array.isArray(props) || Object.keys(props).length === 0) {
    throw new Error("update_deal requires a non-empty properties object");
  }
  const parsed = await requestJson(
    `${base}/crm/v3/objects/deals/${pathSegment(id)}`,
    {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ properties: props }),
    },
    LIST_TIMEOUT_MS,
    HUBSPOT_ERRORS,
  );
  const updatedId = typeof parsed["id"] === "string" ? parsed["id"] : id;
  const fields = Object.keys(props);
  return {
    content: `Deal ${updatedId} updated (${fields.join(", ")}).`,
    meta: { card: "crm", kind: "deal_update", id: updatedId, fields },
  };
}

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
  if (tool === "update_deal") return hubspotUpdateDeal(base, token, args);
  if (tool === "api") return callVendorApi(base, { kind: "bearer", token }, args, VENDOR_API_MAX_CHARS, []);
  if (!(tool in HUBSPOT_SEARCH_TOOLS)) throw new Error(`hubspot integration has no tool ${tool}`);
  const named = HUBSPOT_SEARCH_TOOLS[tool];
  const objectType = named ?? args["object_type"];
  if (typeof objectType !== "string" || objectType === "") throw new Error(`${tool} requires object_type`);
  return hubspotSearch(objectType, base, token, args);
}
