import { FETCH_TIMEOUT_MS, MAX_BODY_CHARS, secretOrNull, configString, fetchJson, clampNumber, truncateWithMarker, superproxyBaseUrl } from "../shared.js";
import type { ToolOutcome, JsonObject } from "../shared.js";
import { assertPublicFetchTarget } from "../fetch-target.js";

// ---------- superproxy ----------

export async function superproxyExecute(config: JsonObject, tool: string, args: JsonObject, secrets: [string, string][], _actingAs: string | null): Promise<ToolOutcome> {
  if (tool !== "web_fetch") throw new Error(`superproxy integration has no tool ${tool}`);
  const target = args["url"];
  if (typeof target !== "string") throw new Error("web_fetch requires url");
  await assertPublicFetchTarget(target);
  const maxChars = clampNumber(args, "max_chars", MAX_BODY_CHARS, MAX_BODY_CHARS);
  const base = superproxyBaseUrl(config);
  // The stored token secret wins; the config token is the legacy fallback.
  const token = secretOrNull(secrets, "token") ?? configString(config, "token");
  const url = new URL(`${base}/v1/fetch`);
  url.searchParams.set("url", target);
  url.searchParams.set("format", "markdown");
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  const body = await fetchJson(url.toString(), { headers }, "superproxy", FETCH_TIMEOUT_MS);
  const pageContent = typeof body["content"] === "string" ? body["content"] : "";
  const title = typeof body["title"] === "string" && body["title"].trim() !== "" ? body["title"].trim() : null;
  const full = title !== null ? `# ${title}\n\n${pageContent}` : pageContent;
  const [content, truncated] = truncateWithMarker(full, maxChars);
  const finalUrl = typeof body["url"] === "string" ? body["url"] : target;
  const statusCode = typeof body["status"] === "number" ? body["status"] : 0;
  const meta: JsonObject = { card: "web", kind: "fetch", url: finalUrl, status_code: statusCode, truncated };
  if (title !== null) meta["title"] = title;
  return { content, meta };
}

