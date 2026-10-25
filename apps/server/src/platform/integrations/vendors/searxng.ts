import { fetchJson, clampNumber, searxngBaseUrl } from "./shared.js";
import type { ToolOutcome, Json } from "./shared.js";

// ---------- searxng ----------

export async function searxngExecute(config: Json, tool: string, args: Json, _secrets: [string, string][], _actingAs: string | null): Promise<ToolOutcome> {
  if (tool !== "web_search") throw new Error(`searxng integration has no tool ${tool}`);
  const query = args["query"];
  if (typeof query !== "string") throw new Error("web_search requires query");
  const count = clampNumber(args, "count", 5, 10);
  const base = searxngBaseUrl(config);
  const url = new URL(`${base}/search`);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  const body = await fetchJson(url.toString(), {}, "searxng");
  const results = Array.isArray(body["results"]) ? (body["results"] as Json[]) : [];
  const truncated = results.length > count;
  let out = "";
  const sources: Json[] = [];
  for (const [i, hit] of results.slice(0, count).entries()) {
    const title = typeof hit["title"] === "string" ? hit["title"] : "(untitled)";
    const hitUrl = typeof hit["url"] === "string" ? hit["url"] : "";
    const snippet = typeof hit["content"] === "string" ? hit["content"] : "";
    out += `${i + 1}. ${title}\n${hitUrl}\n${snippet}\n\n`;
    const src: Json = { url: hitUrl };
    if (title !== "" && title !== "(untitled)") src["title"] = title;
    if (snippet !== "") src["snippet"] = snippet;
    sources.push(src);
  }
  if (out === "") out = "No results.";
  return { content: out, meta: { card: "web", kind: "search", sources, truncated } };
}

