import { LIST_TIMEOUT_MS, VENDOR_API_MAX_CHARS, secretOrNull, pathSegment, requestJson, clampNumber, callVendorApi, hubspotBaseUrl, type JsonRequestErrors } from "../shared.js";
import type { ToolOutcome, JsonObject } from "../shared.js";

// ---------- hubspot ----------

const HUBSPOT_SEARCH_TOOLS: [string, string][] = [
  ["search_contacts", "contacts"],
  ["search_companies", "companies"],
  ["search_deals", "deals"],
];

/** Properties requested per object type (the search API returns only what
 *  the request names). */
function hubspotDisplayProps(object: string): string[] {
  switch (object) {
    case "contacts":
      return ["firstname", "lastname", "email"];
    case "companies":
      return ["name", "domain"];
    default:
      return ["dealname", "amount"];
  }
}

function hubspotSearchLine(index: number, object: string, hit: JsonObject): string {
  const id = typeof hit["id"] === "string" ? hit["id"] : "?";
  const props = (hit["properties"] ?? {}) as JsonObject;
  const values = hubspotDisplayProps(object)
    .map((p) => (typeof props[p] === "string" ? props[p] as string : null))
    .filter((v): v is string => v !== null);
  return `${index + 1}. id=${id} ${values.join(" ")}`;
}

const HUBSPOT_ERRORS: JsonRequestErrors = {
  unreachable: (cause) => `hubspot unreachable: ${cause}`,
  unreadable: () => "hubspot returned bad json",
  status: (status) => `hubspot returned ${status}`,
  badJson: () => "hubspot returned bad json",
};

async function hubspotSearch(object: string, base: string, token: string, args: JsonObject): Promise<ToolOutcome> {
  const query = args["query"];
  if (typeof query !== "string") throw new Error("search requires query");
  const limit = clampNumber(args, "limit", 10, 100);
  const parsed = await requestJson(
    `${base}/crm/v3/objects/${object}/search`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, limit, properties: hubspotDisplayProps(object) }),
    },
    LIST_TIMEOUT_MS,
    HUBSPOT_ERRORS,
  );
  const hits = Array.isArray(parsed["results"]) ? (parsed["results"] as JsonObject[]) : [];
  let content = "";
  const results: JsonObject[] = [];
  for (const [i, hit] of hits.slice(0, limit).entries()) {
    const label = hubspotSearchLine(i, object, hit);
    content += `${label}\n`;
    results.push({ id: hit["id"] ?? null, label });
  }
  if (content === "") content = "No results.";
  return {
    content,
    meta: { card: "crm", kind: "search", object, count: results.length, results },
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

export async function hubspotExecute(config: JsonObject, tool: string, args: JsonObject, secrets: [string, string][], _actingAs: string | null): Promise<ToolOutcome> {
  const token = secretOrNull(secrets, "token");
  if (token === null) throw new Error("hubspot requires the token secret");
  const base = hubspotBaseUrl(config);
  if (tool === "update_deal") return hubspotUpdateDeal(base, token, args);
  if (tool === "api") return callVendorApi(base, { kind: "bearer", token }, args, VENDOR_API_MAX_CHARS, []);
  const object = HUBSPOT_SEARCH_TOOLS.find(([name]) => name === tool)?.[1];
  if (object === undefined) throw new Error(`hubspot integration has no tool ${tool}`);
  return hubspotSearch(object, base, token, args);
}

