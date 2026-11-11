import {
  FETCH_TIMEOUT_MS,
  MAX_BODY_CHARS,
  SCRAPE_EXCERPT_CHARS,
  MAP_LINK_LIMIT,
  secretOrNull,
  requestJson,
  excerpt,
  clampNumber,
  truncateWithMarker,
  firecrawlBaseUrl,
} from "../shared.js";
import type { ToolOutcome, JsonObject } from "../shared.js";
import { assertPublicFetchTarget } from "@guild/integration-sdk";

// ---------- firecrawl ----------

async function firecrawlPost(base: string, path: string, body: JsonObject, key: string | null): Promise<JsonObject> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["authorization"] = `Bearer ${key}`;
  const parsed = await requestJson(
    `${base}${path}`,
    { method: "POST", headers, body: JSON.stringify(body) },
    FETCH_TIMEOUT_MS,
    {
      unreachable: (cause) => `firecrawl unreachable: ${cause}`,
      unreadable: () => "firecrawl returned bad json",
      status: (status, text) => `firecrawl returned ${status}: ${excerpt(text)}`,
      badJson: () => "firecrawl returned bad json",
    },
  );
  if (parsed["success"] === false) {
    throw new Error(`firecrawl error: ${typeof parsed["error"] === "string" ? parsed["error"] : "unknown error"}`);
  }
  return parsed;
}

/** The fallback transport for a page firecrawl cannot return: the
 *  curl-fetch service, one browser-fingerprinted GET. Empty disables it. */
function curlFetchUrl(): string {
  return (process.env["GUILD_CURL_FETCH_URL"] ?? "").trim().replace(/\/+$/, "");
}

/** Fetches one URL through the fallback transport. A binary body is an error:
 *  web_fetch returns text. */
async function curlFetch(base: string, url: string, maxChars: number): Promise<ToolOutcome> {
  const parsed = await requestJson(
    `${base}/fetch`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url }) },
    FETCH_TIMEOUT_MS,
    {
      unreachable: (cause) => `curl-fetch unreachable: ${cause}`,
      unreadable: () => "curl-fetch returned bad json",
      status: (status, text) => `curl-fetch returned ${status}: ${excerpt(text)}`,
      badJson: () => "curl-fetch returned bad json",
    },
  );
  const finalUrl = typeof parsed["url"] === "string" ? parsed["url"] : url;
  const statusCode = typeof parsed["status"] === "number" ? parsed["status"] : 200;
  const contentType = typeof parsed["content_type"] === "string" ? parsed["content_type"] : "";
  if (parsed["binary"] === true) {
    const bytes = typeof parsed["bytes"] === "number" ? parsed["bytes"] : 0;
    throw new Error(`curl-fetch: ${finalUrl} is ${contentType || "a binary file"} (${bytes} bytes), not text`);
  }
  const text = typeof parsed["text"] === "string" ? parsed["text"] : "";
  const [content, truncated] = truncateWithMarker(text, maxChars);
  return {
    content,
    meta: { card: "web", kind: "fetch", url: finalUrl, status_code: statusCode, truncated, engine: "curl" },
  };
}

export async function firecrawlExecute(
  config: JsonObject,
  tool: string,
  args: JsonObject,
  secrets: [string, string][],
  _actingAs: string | null,
): Promise<ToolOutcome> {
  const base = firecrawlBaseUrl(config);
  const key = secretOrNull(secrets, "api_key");
  switch (tool) {
    case "web_fetch": {
      const url = args["url"];
      if (typeof url !== "string") throw new Error("web_fetch requires url");
      await assertPublicFetchTarget(url);
      const maxChars = clampNumber(args, "max_chars", MAX_BODY_CHARS, MAX_BODY_CHARS);
      const fallback = curlFetchUrl();
      let resp: JsonObject;
      try {
        resp = await firecrawlPost(base, "/v1/scrape", { url, formats: ["markdown"] }, key);
      } catch (error) {
        // firecrawl refuses JSON and plain-text endpoints, and pages whose
        // text is too thin for its content heuristics.
        if (fallback === "") throw error;
        try {
          return await curlFetch(fallback, url, maxChars);
        } catch (fallbackError) {
          throw new Error(`${(error as Error).message}; fallback: ${(fallbackError as Error).message}`);
        }
      }
      const data = (resp["data"] ?? {}) as JsonObject;
      const metadata = (data["metadata"] ?? {}) as JsonObject;
      const markdown = typeof data["markdown"] === "string" ? data["markdown"] : "";
      const metaUrl =
        typeof metadata["sourceURL"] === "string"
          ? metadata["sourceURL"]
          : typeof metadata["url"] === "string"
            ? metadata["url"]
            : url;
      const statusCode = typeof metadata["statusCode"] === "number" ? metadata["statusCode"] : 200;
      const [content, truncated] = truncateWithMarker(markdown, maxChars);
      const meta: JsonObject = { card: "web", kind: "fetch", url: metaUrl, status_code: statusCode, truncated };
      const title =
        typeof metadata["title"] === "string" && metadata["title"].trim() !== "" ? metadata["title"].trim() : null;
      if (title !== null) meta["title"] = title;
      return { content, meta };
    }
    case "web_search": {
      const query = args["query"];
      if (typeof query !== "string") throw new Error("web_search requires query");
      const limit = clampNumber(args, "count", 5, 20);
      const body: JsonObject = { query, limit };
      const resp = await firecrawlPost(base, "/v1/search", body, key);
      // The self-hosted API returns a flat results array; the cloud shape
      // nests it under data.web.
      const data = resp["data"];
      const results: JsonObject[] = Array.isArray((data as JsonObject)?.["web"])
        ? ((data as JsonObject)["web"] as JsonObject[])
        : Array.isArray(data)
          ? (data as unknown as JsonObject[])
          : [];
      const truncated = results.length > limit;
      let out = "";
      const sources: JsonObject[] = [];
      for (const [i, hit] of results.slice(0, limit).entries()) {
        const title = typeof hit["title"] === "string" ? hit["title"] : "(untitled)";
        const hitUrl = typeof hit["url"] === "string" ? hit["url"] : "";
        const description = typeof hit["description"] === "string" ? hit["description"] : "";
        out += `${i + 1}. ${title}\n${hitUrl}\n${description}\n\n`;
        if (typeof hit["markdown"] === "string") {
          const [excerptText] = truncateWithMarker(hit["markdown"], SCRAPE_EXCERPT_CHARS);
          out += `${excerptText}\n\n`;
        }
        const src: JsonObject = { url: hitUrl };
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
      await assertPublicFetchTarget(url);
      const resp = await firecrawlPost(base, "/v1/map", { url }, key);
      const links = Array.isArray(resp["links"]) ? resp["links"] : [];
      let out = "";
      for (const link of links.slice(0, MAP_LINK_LIMIT)) {
        const l =
          typeof link === "string"
            ? link
            : typeof link === "object" && link !== null
              ? String((link as JsonObject)["url"] ?? "")
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
