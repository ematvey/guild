import { FETCH_TIMEOUT_MS, MAX_BODY_CHARS, SCRAPE_EXCERPT_CHARS, MAP_LINK_LIMIT, secretOrNull, fetchTimeout, transportCause, excerpt, clampNumber, truncateWithMarker, firecrawlBaseUrl } from "./shared.js";
import type { ToolOutcome, Json } from "./shared.js";

// ---------- firecrawl ----------

async function firecrawlPost(base: string, path: string, body: Json, key: string | null): Promise<Json> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["authorization"] = `Bearer ${key}`;
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, fetchTimeout(FETCH_TIMEOUT_MS, { method: "POST", headers, body: JSON.stringify(body) }));
  } catch (error) {
    throw new Error(`firecrawl unreachable: ${transportCause(error)}`);
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new Error(`firecrawl returned ${res.status}: ${excerpt(text)}`);
  }
  let parsed: Json;
  try {
    parsed = JSON.parse(text) as Json;
  } catch {
    throw new Error("firecrawl returned bad json");
  }
  if (parsed["success"] === false) {
    throw new Error(`firecrawl error: ${typeof parsed["error"] === "string" ? parsed["error"] : "unknown error"}`);
  }
  return parsed;
}

export async function firecrawlExecute(config: Json, tool: string, args: Json, secrets: [string, string][], _actingAs: string | null): Promise<ToolOutcome> {
  const base = firecrawlBaseUrl(config);
  const key = secretOrNull(secrets, "api_key");
  switch (tool) {
    case "web_fetch": {
      const url = args["url"];
      if (typeof url !== "string") throw new Error("web_fetch requires url");
      const maxChars = clampNumber(args, "max_chars", MAX_BODY_CHARS, MAX_BODY_CHARS);
      const resp = await firecrawlPost(base, "/v1/scrape", { url, formats: ["markdown"] }, key);
      const data = (resp["data"] ?? {}) as Json;
      const metadata = (data["metadata"] ?? {}) as Json;
      const markdown = typeof data["markdown"] === "string" ? data["markdown"] : "";
      const metaUrl = typeof metadata["sourceURL"] === "string" ? metadata["sourceURL"] : typeof metadata["url"] === "string" ? metadata["url"] : url;
      const statusCode = typeof metadata["statusCode"] === "number" ? metadata["statusCode"] : 200;
      const [content, truncated] = truncateWithMarker(markdown, maxChars);
      const meta: Json = { card: "web", kind: "fetch", url: metaUrl, status_code: statusCode, truncated };
      const title = typeof metadata["title"] === "string" && metadata["title"].trim() !== "" ? metadata["title"].trim() : null;
      if (title !== null) meta["title"] = title;
      return { content, meta };
    }
    case "web_search": {
      const query = args["query"];
      if (typeof query !== "string") throw new Error("web_search requires query");
      const limit = clampNumber(args, "count", 5, 20);
      const body: Json = { query, limit };
      const resp = await firecrawlPost(base, "/v1/search", body, key);
      // The self-hosted API returns a flat results array; the cloud shape
      // nests it under data.web.
      const data = resp["data"];
      const results: Json[] = Array.isArray((data as Json)?.["web"])
        ? ((data as Json)["web"] as Json[])
        : Array.isArray(data)
          ? (data as unknown as Json[])
          : [];
      const truncated = results.length > limit;
      let out = "";
      const sources: Json[] = [];
      for (const [i, hit] of results.slice(0, limit).entries()) {
        const title = typeof hit["title"] === "string" ? hit["title"] : "(untitled)";
        const hitUrl = typeof hit["url"] === "string" ? hit["url"] : "";
        const description = typeof hit["description"] === "string" ? hit["description"] : "";
        out += `${i + 1}. ${title}\n${hitUrl}\n${description}\n\n`;
        if (typeof hit["markdown"] === "string") {
          const [excerptText] = truncateWithMarker(hit["markdown"], SCRAPE_EXCERPT_CHARS);
          out += `${excerptText}\n\n`;
        }
        const src: Json = { url: hitUrl };
        if (title !== "" && title !== "(untitled)") src["title"] = title;
        if (description !== "") src["snippet"] = description;
        sources.push(src);
      }
      if (out === "") out = "No results.";
      return { content: out, meta: { card: "web", kind: "search", sources, truncated } };
    }
    case "map": {
      const url = args["url"];
      if (typeof url !== "string") throw new Error("map requires url");
      const resp = await firecrawlPost(base, "/v1/map", { url }, key);
      const links = Array.isArray(resp["links"]) ? resp["links"] : [];
      let out = "";
      for (const link of links.slice(0, MAP_LINK_LIMIT)) {
        const l = typeof link === "string"
          ? link
          : typeof link === "object" && link !== null
            ? String((link as Json)["url"] ?? "")
            : "";
        if (l !== "") out += `${l}\n`;
      }
      if (out === "") out = "No links found.";
      return { content: out };
    }
    default:
      throw new Error(`firecrawl integration has no tool ${tool}`);
  }
}

