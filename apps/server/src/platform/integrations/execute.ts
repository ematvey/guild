// The connector execute runtime: one execute function per built-in
// connector, the
// shared generic `api` tool (call_vendor_api), and the plugin dispatcher
// (call_plugin) that re-resolves secrets and runs the built-in connector or
// the MCP peer. A connector failure is a tool RESULT (the error text the
// model sees), never a thrown HTTP error — callers map ToolOutcome to the
// tool result they surface.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createSign } from "node:crypto";
import { mcpConnect, type McpPeer } from "./mcp.js";
import { envelopeHeaders, type PluginTurn } from "./plugins.js";

export interface ToolOutcome {
  content: string;
  meta?: unknown;
  /** Binary payload the tool hands the model as a spilled artifact: the
   *  caller materializes the bytes and replaces `content` with the pointer
   *  text (chat path). The script API drops the payload (as in Rust). */
  artifact?: { filename: string; contentType: string; bytes: Buffer };
}

type Json = Record<string, unknown>;

const CALL_TIMEOUT_MS = 20_000;
const LIST_TIMEOUT_MS = 30_000;
const API_TIMEOUT_MS = 60_000;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_BODY_CHARS = 8_000;
const API_MAX_CHARS = 1_024 * 1_024;
const VENDOR_API_MAX_CHARS = 12_000;
const MAX_BODY_SNIPPET = 300;
const SCRAPE_EXCERPT_CHARS = 2_000;
const MAP_LINK_LIMIT = 500;
const FIRECRAWL_DEFAULT_BASE_URL = "http://host.docker.internal:13002";

export function secret(secrets: [string, string][], name: string): string {
  const found = secrets.find(([n]) => n === name);
  if (found === undefined) throw new Error(`secret ${name} is not stored`);
  return found[1];
}

function secretOrNull(secrets: [string, string][], name: string): string | null {
  const found = secrets.find(([n]) => n === name);
  return found === undefined ? null : found[1];
}

function configString(config: Json, name: string): string | undefined {
  const v = config[name];
  return typeof v === "string" ? v : undefined;
}

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/** Percent-encodes one URL path segment (path_segment): user- and
 *  model-controlled values must not inject `/`,
 *  `?` or `#` into a vendor request path; a dot-segment is rejected. */
export function pathSegment(value: string): string {
  if (value === "." || value === "..") {
    throw new Error(`path segment "${value}" is not allowed`);
  }
  let out = "";
  for (const b of Buffer.from(value, "utf8")) {
    if (
      (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || (b >= 0x30 && b <= 0x39) ||
      b === 0x2d || b === 0x5f || b === 0x2e || b === 0x7e
    ) {
      out += String.fromCharCode(b);
    } else {
      out += `%${b.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/** Percent-encodes a query-string value (urlencoding_lite). */
function urlencode(value: string): string {
  return pathSegment(value);
}

const callSignals = new AsyncLocalStorage<AbortSignal | undefined>();

function fetchTimeout(ms: number, init?: RequestInit): RequestInit {
  const signal = callSignals.getStore();
  signal?.throwIfAborted();
  const signals = [AbortSignal.timeout(ms)];
  if (signal) signals.push(signal);
  if (init?.signal) signals.push(init.signal);
  return { ...init, signal: AbortSignal.any(signals) };
}

function transportCause(error: unknown): string {
  return error instanceof Error
    ? (error.cause instanceof Error ? error.cause.message : error.message)
    : String(error);
}

/** Char-bounded head of an error body (byte slicing would cut a multibyte
 *  character in half). */
function excerpt(text: string, max = MAX_BODY_SNIPPET): string {
  return [...text].slice(0, max).join("");
}

async function fetchJson(url: string, init: RequestInit, api: string, timeoutMs = CALL_TIMEOUT_MS): Promise<Json> {
  let res: Response;
  try {
    res = await fetch(url, fetchTimeout(timeoutMs, init));
  } catch (error) {
    throw new Error(`${api} unreachable: ${transportCause(error)}`);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (error) {
    throw new Error(`${api} returned unreadable body: ${transportCause(error)}`);
  }
  if (!res.ok) {
    throw new Error(`${api} returned ${res.status}: ${excerpt(text)}`);
  }
  try {
    return JSON.parse(text) as Json;
  } catch (error) {
    throw new Error(`${api} returned bad json: ${(error as Error).message}`);
  }
}

function clampNumber(args: Json, name: string, dflt: number, cap: number): number {
  const v = args[name];
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : dflt;
  return Math.min(Math.max(n, 1), cap);
}

function truncateWithMarker(text: string, maxChars: number): [string, boolean] {
  const chars = [...text];
  if (chars.length <= maxChars) return [text, false];
  return [`${chars.slice(0, maxChars).join("")}\n\n[truncated]`, true];
}

// ---------- the shared generic `api` tool (call_vendor_api) ----------

type ApiAuth =
  | { kind: "bearer"; token: string }
  | { kind: "basic"; user: string; pass: string }
  | { kind: "private_token"; token: string };

/** Runs one generic vendor REST call: `path` must start with `/`; the
 *  method is whitelisted; the body rides as JSON when present. The raw
 *  response text is the content, truncated to `max_chars`. */
async function callVendorApi(base: string, auth: ApiAuth, args: Json, maxChars: number, extraHeaders: [string, string][] = []): Promise<ToolOutcome> {
  const path = args["path"];
  if (typeof path !== "string") throw new Error("api requires path (starting with /)");
  if (!path.startsWith("/")) throw new Error("api path must start with /");
  const rawMethod = typeof args["method"] === "string" ? args["method"].toUpperCase() : "GET";
  if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(rawMethod)) {
    throw new Error(`api method ${rawMethod} not allowed`);
  }
  const headers: Record<string, string> = {};
  if (auth.kind === "bearer") headers["authorization"] = `Bearer ${auth.token}`;
  else if (auth.kind === "basic") headers["authorization"] = `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString("base64")}`;
  else headers["PRIVATE-TOKEN"] = auth.token;
  for (const [name, value] of extraHeaders) headers[name] = value;
  const url = new URL(`${base}${path}`);
  const query = args["query"];
  if (query !== null && typeof query === "object" && !Array.isArray(query)) {
    for (const [k, v] of Object.entries(query as Json)) {
      url.searchParams.set(k, typeof v === "string" ? v : JSON.stringify(v) ?? "");
    }
  }
  const body = args["body"];
  const hasBody = body !== null && typeof body === "object" && !Array.isArray(body) && Object.keys(body).length > 0;
  const init: RequestInit = {
    method: rawMethod,
    headers: hasBody ? { ...headers, "content-type": "application/json" } : headers,
    body: hasBody ? JSON.stringify(body) : undefined,
  };
  let res: Response;
  try {
    res = await fetch(url, fetchTimeout(API_TIMEOUT_MS, init));
  } catch (error) {
    throw new Error(`api call failed: ${transportCause(error)}`);
  }
  let text: string;
  try {
    text = await res.text();
  } catch (error) {
    throw new Error(`api body unreadable: ${transportCause(error)}`);
  }
  if (!res.ok) {
    throw new Error(`api returned ${res.status}: ${excerpt(text)}`);
  }
  const [content, truncated] = truncateWithMarker(text, maxChars);
  return {
    content,
    meta: { card: "api", kind: "api", status: res.status, truncated },
  };
}

// ---------- searxng ----------

async function searxngExecute(config: Json, tool: string, args: Json, _secrets: [string, string][], _actingAs: string | null): Promise<ToolOutcome> {
  if (tool !== "web_search") throw new Error(`searxng integration has no tool ${tool}`);
  const query = args["query"];
  if (typeof query !== "string") throw new Error("web_search requires query");
  const count = clampNumber(args, "count", 5, 10);
  const base = configString(config, "base_url");
  if (base === undefined) throw new Error("searxng config requires base_url");
  const url = new URL(`${trimTrailingSlash(base)}/search`);
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

// ---------- superproxy ----------

async function superproxyExecute(config: Json, tool: string, args: Json, secrets: [string, string][], _actingAs: string | null): Promise<ToolOutcome> {
  if (tool !== "web_fetch") throw new Error(`superproxy integration has no tool ${tool}`);
  const target = args["url"];
  if (typeof target !== "string") throw new Error("web_fetch requires url");
  const maxChars = clampNumber(args, "max_chars", MAX_BODY_CHARS, MAX_BODY_CHARS);
  const base = configString(config, "base_url");
  if (base === undefined) throw new Error("superproxy config requires base_url");
  // The stored token secret wins; the config token is the legacy fallback.
  const token = secretOrNull(secrets, "token") ?? configString(config, "token");
  const url = new URL(`${trimTrailingSlash(base)}/v1/fetch`);
  url.searchParams.set("url", target);
  url.searchParams.set("format", "markdown");
  const headers: Record<string, string> = {};
  if (token !== undefined) headers["authorization"] = `Bearer ${token}`;
  const body = await fetchJson(url.toString(), { headers }, "search tool", FETCH_TIMEOUT_MS);
  const pageContent = typeof body["content"] === "string" ? body["content"] : "";
  const title = typeof body["title"] === "string" && body["title"].trim() !== "" ? body["title"].trim() : null;
  const full = title !== null ? `# ${title}\n\n${pageContent}` : pageContent;
  const [content, truncated] = truncateWithMarker(full, maxChars);
  const finalUrl = typeof body["url"] === "string" ? body["url"] : target;
  const statusCode = typeof body["status"] === "number" ? body["status"] : 0;
  const meta: Json = { card: "web", kind: "fetch", url: finalUrl, status_code: statusCode, truncated };
  if (title !== null) meta["title"] = title;
  return { content, meta };
}

// ---------- firecrawl ----------

function firecrawlBaseUrl(config: Json): string {
  const fromConfig = configString(config, "base_url");
  return trimTrailingSlash(fromConfig !== undefined && fromConfig !== "" ? fromConfig : FIRECRAWL_DEFAULT_BASE_URL);
}

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

async function firecrawlExecute(config: Json, tool: string, args: Json, secrets: [string, string][], _actingAs: string | null): Promise<ToolOutcome> {
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

// ---------- google_workspace ----------

const GOOGLE_SCOPES =
  "https://www.googleapis.com/auth/gmail.readonly " +
  "https://www.googleapis.com/auth/calendar.readonly " +
  "https://www.googleapis.com/auth/drive.readonly " +
  "https://www.googleapis.com/auth/admin.directory.user.readonly";
const GOOGLE_DEFAULT_API_BASE = "https://www.googleapis.com";
const GOOGLE_DEFAULT_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWT_TTL_SECS = 3600;
/** A cached access token refreshes this long before its own expiry. */
const GOOGLE_EXPIRY_MARGIN_MS = 60_000;

interface CachedGoogleToken {
  token: string;
  expiresAtMs: number;
}

/** Access tokens keyed by `token_url|client_email|subject|secret
 *  fingerprint` — one entry per acting identity AND credential, shared
 *  across calls in this process (the Rust GoogleWorkspace token cache). */
const googleTokens = new Map<string, CachedGoogleToken>();

function googleApiBase(config: Json): string {
  const v = configString(config, "api_base");
  return v !== undefined ? v.replace(/\/+$/, "") : GOOGLE_DEFAULT_API_BASE;
}

function googleTokenUrl(config: Json): string {
  const v = configString(config, "token_url");
  return v !== undefined ? v.replace(/\/+$/, "") : GOOGLE_DEFAULT_TOKEN_URL;
}

function googleServiceAccount(secrets: [string, string][]): { clientEmail: string; privateKey: string } {
  const raw = secret(secrets, "service_account_json");
  let parsed: Json;
  try {
    parsed = JSON.parse(raw) as Json;
  } catch (error) {
    throw new Error(`service_account_json is not valid json: ${(error as Error).message}`);
  }
  const clientEmail = parsed["client_email"];
  if (typeof clientEmail !== "string") throw new Error("service_account_json missing client_email");
  const privateKey = parsed["private_key"];
  if (typeof privateKey !== "string") throw new Error("service_account_json missing private_key");
  return { clientEmail, privateKey };
}

function googleAdminEmail(config: Json, secrets: [string, string][]): string {
  const fromConfig = configString(config, "admin_email");
  if (fromConfig !== undefined) return fromConfig;
  return secret(secrets, "admin_email");
}

/** Acting identity for the `sub` claim: the call's `acting_as` value when
 *  present, else the `admin_email` default subject. */
function googleActingIdentity(actingAs: string | null, adminEmail: string): string {
  return actingAs ?? adminEmail;
}

async function googleAccessToken(config: Json, secrets: [string, string][], sub: string): Promise<string> {
  const { clientEmail, privateKey } = googleServiceAccount(secrets);
  const tokenUrl = googleTokenUrl(config);
  const secretFingerprint = createHash("sha256").update(secret(secrets, "service_account_json")).digest("hex");
  const cacheKey = `${tokenUrl}|${clientEmail}|${sub}|${secretFingerprint}`;
  const cached = googleTokens.get(cacheKey);
  if (cached !== undefined && cached.expiresAtMs > Date.now() + GOOGLE_EXPIRY_MARGIN_MS) {
    return cached.token;
  }
  const now = Math.floor(Date.now() / 1000);
  const b64url = (input: string): string => Buffer.from(input, "utf8").toString("base64url");
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(
    JSON.stringify({ iss: clientEmail, sub, scope: GOOGLE_SCOPES, aud: tokenUrl, iat: now, exp: now + GOOGLE_JWT_TTL_SECS }),
  );
  let assertion: string;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    assertion = `${header}.${claims}.${signer.sign(privateKey).toString("base64url")}`;
  } catch (error) {
    throw new Error(`service account jwt signing failed: ${(error as Error).message}`);
  }
  let res: Response;
  try {
    res = await fetch(tokenUrl, fetchTimeout(CALL_TIMEOUT_MS, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }).toString(),
    }));
  } catch (error) {
    throw new Error(`google token endpoint unreachable: ${transportCause(error)}`);
  }
  if (!res.ok) throw new Error(`google token endpoint returned ${res.status}`);
  let body: Json;
  try {
    body = (await res.json()) as Json;
  } catch (error) {
    throw new Error(`google token endpoint returned bad json: ${(error as Error).message}`);
  }
  const token = body["access_token"];
  if (typeof token !== "string") throw new Error("google token response missing access_token");
  // Clamp: a nonsensical expires_in must not poison the cache.
  const expiresIn =
    typeof body["expires_in"] === "number" && Number.isFinite(body["expires_in"])
      ? Math.trunc(body["expires_in"])
      : GOOGLE_JWT_TTL_SECS;
  googleTokens.set(cacheKey, { token, expiresAtMs: Date.now() + Math.min(Math.max(expiresIn, 1), 86_400) * 1000 });
  return token;
}

async function googleAccessTokenFor(config: Json, secrets: [string, string][], actingAs: string | null): Promise<string> {
  return googleAccessToken(config, secrets, googleActingIdentity(actingAs, googleAdminEmail(config, secrets)));
}

async function googleGetJson(url: string, token: string, api: string): Promise<Json> {
  return fetchJson(url, { headers: { authorization: `Bearer ${token}` } }, api);
}

/** Decodes a Gmail base64url body part to raw bytes. */
function decodeBodyPartBytes(data: string): Buffer | null {
  try {
    return Buffer.from(data.replace(/=+$/, ""), "base64url");
  } catch {
    return null;
  }
}

function isUtf8(bytes: Buffer): boolean {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes);
}

/** Replaces tag markup with a single space — a readable-text fallback for
 *  html-only messages. */
function stripHtmlTags(html: string): string {
  let out = "";
  let inTag = false;
  for (const ch of html) {
    if (ch === "<") inTag = true;
    else if (ch === ">") inTag = false;
    else if (!inTag) out += ch;
  }
  return out;
}

/** Depth-first search of the MIME tree for a readable text body:
 *  text/plain wins, text/html is a fallback (tags stripped). */
function extractBody(payload: Json): string | null {
  const mime = typeof payload["mimeType"] === "string" ? payload["mimeType"] : "";
  const body = payload["body"];
  const data = body !== null && typeof body === "object" && typeof (body as Json)["data"] === "string"
    ? (body as Json)["data"] as string
    : null;
  if (data !== null) {
    const bytes = decodeBodyPartBytes(data);
    const text = bytes !== null && isUtf8(bytes) ? bytes.toString("utf8") : null;
    if (text !== null) {
      if (mime === "text/plain") return text;
      if (mime === "text/html") return stripHtmlTags(text);
    }
  }
  const parts = Array.isArray(payload["parts"]) ? (payload["parts"] as Json[]) : null;
  if (parts !== null) {
    for (const part of parts) {
      const found = extractBody(part);
      if (found !== null) return found;
    }
  }
  return null;
}

function headerValue(payload: Json, name: string): string | null {
  const headers = Array.isArray(payload["headers"]) ? (payload["headers"] as Json[]) : [];
  const found = headers.find(
    (h) => typeof h["name"] === "string" && (h["name"] as string).toLowerCase() === name.toLowerCase(),
  );
  return found !== undefined && typeof found["value"] === "string" ? found["value"] : null;
}

function truncateBody(text: string): string {
  const chars = [...text];
  if (chars.length <= MAX_BODY_CHARS) return text;
  return `${chars.slice(0, MAX_BODY_CHARS).join("")}\n\n[truncated]`;
}

/** Attachment parts of a message: (filename, mime, attachment id). */
function attachmentParts(payload: Json): [string, string, string][] {
  const out: [string, string, string][] = [];
  const walk = (part: Json): void => {
    const body = part["body"];
    const id = body !== null && typeof body === "object" && typeof (body as Json)["attachmentId"] === "string"
      ? (body as Json)["attachmentId"] as string
      : null;
    // Body parts of the message text carry an empty attachment id; a part
    // with a real id is an attachment.
    if (id !== null && id !== "") {
      const filename =
        (typeof part["filename"] === "string" && part["filename"] !== "" ? part["filename"] : null) ??
        headerValue(part, "filename") ??
        "(unnamed)";
      const mime = typeof part["mimeType"] === "string" ? part["mimeType"] : "application/octet-stream";
      out.push([filename, mime, id]);
    }
    const parts = Array.isArray(part["parts"]) ? (part["parts"] as Json[]) : [];
    for (const child of parts) walk(child);
  };
  walk(payload);
  return out;
}

async function gmailSearch(config: Json, args: Json, token: string): Promise<ToolOutcome> {
  const query = args["query"];
  if (typeof query !== "string") throw new Error("gmail_search requires query");
  const url = `${googleApiBase(config)}/gmail/v1/users/me/messages?q=${urlencode(query)}&maxResults=${clampNumber(args, "max_results", 10, 25)}`;
  const body = await googleGetJson(url, token, "gmail");
  const messages = Array.isArray(body["messages"]) ? (body["messages"] as Json[]) : [];
  if (messages.length === 0) {
    return { content: "No messages match the search." };
  }
  let out = `Gmail search "${query}": ${typeof body["resultSizeEstimate"] === "number" ? body["resultSizeEstimate"] : messages.length} result(s)\n`;
  for (const m of messages) {
    out += `- id ${typeof m["id"] === "string" ? m["id"] : "?"} (thread ${typeof m["threadId"] === "string" ? m["threadId"] : "?"})\n`;
  }
  if (typeof body["nextPageToken"] === "string") {
    out += "(more results available — narrow the query)\n";
  }
  return { content: out };
}

async function gmailGetMessage(config: Json, args: Json, token: string): Promise<ToolOutcome> {
  const id = args["message_id"];
  if (typeof id !== "string") throw new Error("gmail_get_message requires message_id");
  const body = await googleGetJson(`${googleApiBase(config)}/gmail/v1/users/me/messages/${urlencode(id)}`, token, "gmail");
  const payload = (body["payload"] ?? {}) as Json;
  let out = "";
  for (const header of ["Subject", "From", "Date"]) {
    const v = headerValue(payload, header);
    if (v !== null) out += `${header}: ${v}\n`;
  }
  out += "\n";
  const text = extractBody(payload);
  out += text !== null ? truncateBody(text) : `(no text body — snippet: ${typeof body["snippet"] === "string" ? body["snippet"] : "none"})`;
  const parts = attachmentParts(payload);
  if (parts.length > 0) {
    out += "\nAttachments:\n";
    for (const [filename, mime, attachmentId] of parts) {
      out += `- ${filename} (${mime}; attachment id ${attachmentId})\n`;
    }
  }
  return { content: out };
}

async function gmailGetAttachment(config: Json, args: Json, token: string): Promise<ToolOutcome> {
  const messageId = args["message_id"];
  if (typeof messageId !== "string") throw new Error("gmail_get_attachment requires message_id");
  const attachmentId = args["attachment_id"];
  if (typeof attachmentId !== "string") throw new Error("gmail_get_attachment requires attachment_id");
  // The attachment endpoint returns only size + base64url data; the part
  // metadata (filename, mime) comes from the message itself.
  const message = await googleGetJson(`${googleApiBase(config)}/gmail/v1/users/me/messages/${urlencode(messageId)}`, token, "gmail");
  const part = attachmentParts((message["payload"] ?? {}) as Json).find(([, , id]) => id === attachmentId);
  const filename =
    (typeof args["filename"] === "string" ? args["filename"] : null) ??
    part?.[0] ??
    `gmail_${attachmentId}.bin`;
  const contentType = part?.[1] ?? "application/octet-stream";
  const body = await googleGetJson(
    `${googleApiBase(config)}/gmail/v1/users/me/messages/${urlencode(messageId)}/attachments/${urlencode(attachmentId)}`,
    token,
    "gmail",
  );
  const data = typeof body["data"] === "string" ? body["data"] : null;
  if (data === null) throw new Error("gmail attachment response missing data");
  const bytes = decodeBodyPartBytes(data);
  if (bytes === null) throw new Error("gmail attachment data is not valid base64url");
  return {
    content: `attachment ${filename} (${bytes.length} bytes, ${contentType})`,
    artifact: { filename, contentType, bytes },
  };
}

async function calendarListEvents(config: Json, args: Json, token: string): Promise<ToolOutcome> {
  // timeMin defaults to now: without it the API expands recurring events
  // from their first instance and ascending startTime order makes the
  // first page decades of old recurrences instead of upcoming events.
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const timeMin = typeof args["time_min"] === "string" ? args["time_min"] : now;
  let url = `${googleApiBase(config)}/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=${clampNumber(args, "max_results", 10, 50)}&timeMin=${urlencode(timeMin)}`;
  if (typeof args["time_max"] === "string") url += `&timeMax=${urlencode(args["time_max"])}`;
  const body = await googleGetJson(url, token, "calendar");
  const items = Array.isArray(body["items"]) ? (body["items"] as Json[]) : [];
  if (items.length === 0) {
    return { content: "No events in the requested window." };
  }
  let out = `Calendar events: ${items.length}\n`;
  for (const e of items) {
    const start = (e["start"] ?? {}) as Json;
    const startText = typeof start["dateTime"] === "string" ? start["dateTime"] : typeof start["date"] === "string" ? start["date"] : "(no start)";
    out += `- ${startText} ${typeof e["summary"] === "string" ? e["summary"] : "(untitled)"}\n`;
  }
  return { content: out };
}

/** `name contains '<value>'` with the quote escaped for the Drive query
 *  grammar. */
function driveNameQuery(name: string): string {
  return `name contains '${name.replace(/'/g, "\\'")}'`;
}

async function driveSearch(config: Json, args: Json, token: string): Promise<ToolOutcome> {
  const name = args["name"];
  if (typeof name !== "string") throw new Error("drive_search requires name");
  const url = `${googleApiBase(config)}/drive/v3/files?q=${urlencode(driveNameQuery(name))}&fields=files(id,name,mimeType)&pageSize=${clampNumber(args, "max_results", 10, 50)}`;
  const body = await googleGetJson(url, token, "drive");
  const files = Array.isArray(body["files"]) ? (body["files"] as Json[]) : [];
  if (files.length === 0) {
    return { content: `No Drive files matching "${name}".` };
  }
  let out = `Drive files matching "${name}": ${files.length}\n`;
  for (const f of files) {
    out += `- ${typeof f["name"] === "string" ? f["name"] : "(untitled)"} — ${typeof f["mimeType"] === "string" ? f["mimeType"] : "unknown"} (id ${typeof f["id"] === "string" ? f["id"] : "?"})\n`;
  }
  return { content: out };
}

async function directoryUsers(config: Json, args: Json, secrets: [string, string][], token: string): Promise<ToolOutcome> {
  // Default domain: the admin_email's own domain (domain-wide delegation
  // is scoped to the service account's workspace).
  let admin = "";
  try {
    admin = googleAdminEmail(config, secrets);
  } catch {
    admin = "";
  }
  const defaultDomain = admin.split("@").pop() ?? "";
  const domain = typeof args["domain"] === "string" ? args["domain"] : defaultDomain;
  const url = domain === ""
    ? `${googleApiBase(config)}/admin/directory/v1/users?customer=my_customer&maxResults=${clampNumber(args, "max_results", 20, 50)}`
    : `${googleApiBase(config)}/admin/directory/v1/users?domain=${urlencode(domain)}&maxResults=${clampNumber(args, "max_results", 20, 50)}`;
  const body = await googleGetJson(url, token, "directory");
  const users = Array.isArray(body["users"]) ? (body["users"] as Json[]) : [];
  if (users.length === 0) {
    return { content: `No directory users in domain "${domain}".` };
  }
  let out = `Directory users (domain ${domain}): ${users.length}\n`;
  for (const u of users) {
    const name = (u["name"] ?? {}) as Json;
    out += `- ${typeof u["primaryEmail"] === "string" ? u["primaryEmail"] : "(no email)"} — ${typeof name["fullName"] === "string" ? name["fullName"] : "(no name)"}\n`;
  }
  return { content: out };
}

async function googleWorkspaceExecute(config: Json, tool: string, args: Json, secrets: [string, string][], actingAs: string | null): Promise<ToolOutcome> {
  // Dispatch first: an unknown tool fails without touching the network.
  // Per-call identity: acting_as is the DWD `sub`; the default subject is
  // admin_email.
  if (tool === "api") {
    const token = await googleAccessTokenFor(config, secrets, actingAs);
    return callVendorApi(googleApiBase(config), { kind: "bearer", token }, args, API_MAX_CHARS, []);
  }
  switch (tool) {
    case "gmail_search": {
      const token = await googleAccessTokenFor(config, secrets, actingAs);
      return gmailSearch(config, args, token);
    }
    case "gmail_get_message": {
      const token = await googleAccessTokenFor(config, secrets, actingAs);
      return gmailGetMessage(config, args, token);
    }
    case "gmail_get_attachment": {
      const token = await googleAccessTokenFor(config, secrets, actingAs);
      return gmailGetAttachment(config, args, token);
    }
    case "calendar_list_events": {
      const token = await googleAccessTokenFor(config, secrets, actingAs);
      return calendarListEvents(config, args, token);
    }
    case "drive_search": {
      const token = await googleAccessTokenFor(config, secrets, actingAs);
      return driveSearch(config, args, token);
    }
    case "directory_users": {
      const token = await googleAccessTokenFor(config, secrets, actingAs);
      return directoryUsers(config, args, secrets, token);
    }
    default:
      throw new Error(`google_workspace integration has no tool ${tool}`);
  }
}

// ---------- hubspot ----------

function hubspotBaseUrl(config: Json): string {
  return trimTrailingSlash(configString(config, "base_url") ?? "https://api.hubapi.com");
}

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

function hubspotSearchLine(index: number, object: string, hit: Json): string {
  const id = typeof hit["id"] === "string" ? hit["id"] : "?";
  const props = (hit["properties"] ?? {}) as Json;
  const values = hubspotDisplayProps(object)
    .map((p) => (typeof props[p] === "string" ? props[p] as string : null))
    .filter((v): v is string => v !== null);
  return `${index + 1}. id=${id} ${values.join(" ")}`;
}

async function hubspotSearch(object: string, base: string, token: string, args: Json): Promise<ToolOutcome> {
  const query = args["query"];
  if (typeof query !== "string") throw new Error("search requires query");
  const limit = clampNumber(args, "limit", 10, 100);
  let res: Response;
  try {
    res = await fetch(`${base}/crm/v3/objects/${object}/search`, fetchTimeout(LIST_TIMEOUT_MS, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query, limit, properties: hubspotDisplayProps(object) }),
    }));
  } catch (error) {
    throw new Error(`hubspot unreachable: ${transportCause(error)}`);
  }
  if (!res.ok) throw new Error(`hubspot returned ${res.status}`);
  let parsed: Json;
  try {
    parsed = (await res.json()) as Json;
  } catch {
    throw new Error("hubspot returned bad json");
  }
  const hits = Array.isArray(parsed["results"]) ? (parsed["results"] as Json[]) : [];
  let content = "";
  const results: Json[] = [];
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

async function hubspotUpdateDeal(base: string, token: string, args: Json): Promise<ToolOutcome> {
  const id = args["id"];
  if (typeof id !== "string") throw new Error("update_deal requires id");
  const props = args["properties"];
  if (props === null || typeof props !== "object" || Array.isArray(props) || Object.keys(props).length === 0) {
    throw new Error("update_deal requires a non-empty properties object");
  }
  let res: Response;
  try {
    res = await fetch(`${base}/crm/v3/objects/deals/${pathSegment(id)}`, fetchTimeout(LIST_TIMEOUT_MS, {
      method: "PATCH",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ properties: props }),
    }));
  } catch (error) {
    throw new Error(`hubspot unreachable: ${transportCause(error)}`);
  }
  if (!res.ok) throw new Error(`hubspot returned ${res.status}`);
  let parsed: Json;
  try {
    parsed = (await res.json()) as Json;
  } catch {
    throw new Error("hubspot returned bad json");
  }
  const updatedId = typeof parsed["id"] === "string" ? parsed["id"] : id;
  const fields = Object.keys(props);
  return {
    content: `Deal ${updatedId} updated (${fields.join(", ")}).`,
    meta: { card: "crm", kind: "deal_update", id: updatedId, fields },
  };
}

async function hubspotExecute(config: Json, tool: string, args: Json, secrets: [string, string][], _actingAs: string | null): Promise<ToolOutcome> {
  const token = secretOrNull(secrets, "token");
  if (token === null) throw new Error("hubspot requires the token secret");
  const base = hubspotBaseUrl(config);
  if (tool === "update_deal") return hubspotUpdateDeal(base, token, args);
  if (tool === "api") return callVendorApi(base, { kind: "bearer", token }, args, VENDOR_API_MAX_CHARS, []);
  const object = HUBSPOT_SEARCH_TOOLS.find(([name]) => name === tool)?.[1];
  if (object === undefined) throw new Error(`hubspot integration has no tool ${tool}`);
  return hubspotSearch(object, base, token, args);
}

// ---------- langfuse ----------

function langfuseBaseUrl(config: Json, secrets: [string, string][]): string {
  // The config base_url wins; the legacy `host` secret of pre-schema
  // deployments is the fallback; else the public cloud.
  const fromConfig = configString(config, "base_url");
  if (fromConfig !== undefined) return trimTrailingSlash(fromConfig);
  const host = secretOrNull(secrets, "host");
  if (host !== null) return trimTrailingSlash(host);
  return "https://cloud.langfuse.com";
}

async function langfuseGet(base: string, path: string, publicKey: string, secretKey: string): Promise<Json> {
  const basic = Buffer.from(`${publicKey}:${secretKey}`).toString("base64");
  return fetchJson(`${base}${path}`, { headers: { authorization: `Basic ${basic}` } }, "langfuse");
}

async function langfuseExecute(config: Json, tool: string, args: Json, secrets: [string, string][], _actingAs: string | null): Promise<ToolOutcome> {
  const publicKey = secret(secrets, "public_key");
  const secretKey = secret(secrets, "secret_key");
  const base = langfuseBaseUrl(config, secrets);
  switch (tool) {
    case "list_traces": {
      const limit = clampNumber(args, "limit", 10, 50);
      const body = await langfuseGet(base, `/api/public/traces?limit=${limit}`, publicKey, secretKey);
      const traces = Array.isArray(body["data"]) ? (body["data"] as Json[]) : [];
      let content = "";
      for (const [i, trace] of traces.slice(0, limit).entries()) {
        const id = typeof trace["id"] === "string" ? trace["id"] : "?";
        const name = typeof trace["name"] === "string" ? trace["name"] : "(unnamed)";
        const timestamp = typeof trace["timestamp"] === "string" ? trace["timestamp"] : "";
        content += `${i + 1}. ${id} ${name} ${timestamp}\n`;
      }
      if (content === "") content = "No traces.";
      return { content, meta: { card: "langfuse", kind: "traces", count: Math.min(traces.length, limit) } };
    }
    case "get_trace": {
      const traceId = args["trace_id"];
      if (typeof traceId !== "string") throw new Error("get_trace requires trace_id");
      const trace = await langfuseGet(base, `/api/public/traces/${pathSegment(traceId)}`, publicKey, secretKey);
      return {
        content: JSON.stringify(trace, null, 2),
        meta: { card: "langfuse", kind: "trace", id: trace["id"] ?? null },
      };
    }
    case "get_prompt": {
      const name = args["name"];
      if (typeof name !== "string") throw new Error("get_prompt requires name");
      // The prompt name is a path segment (folder names carry `/`):
      // encoded, so it cannot escape the segment or carry `?`/`#`.
      const version = typeof args["version"] === "number" && Number.isFinite(args["version"]) ? Math.trunc(args["version"]) : null;
      const path = version !== null
        ? `/api/public/v2/prompts/${pathSegment(name)}?version=${version}`
        : `/api/public/v2/prompts/${pathSegment(name)}`;
      const body = await langfuseGet(base, path, publicKey, secretKey);
      const promptName = typeof body["name"] === "string" ? body["name"] : name;
      const promptVersion = typeof body["version"] === "number" ? body["version"] : 0;
      const kind = typeof body["type"] === "string" ? body["type"] : "text";
      return {
        content: `${promptName} v${promptVersion} (${kind})\n\n${JSON.stringify(body["prompt"] ?? null, null, 2)}`,
        meta: { card: "langfuse", kind: "prompt", name: promptName, version: promptVersion },
      };
    }
    case "api":
      return callVendorApi(base, { kind: "basic", user: publicKey, pass: secretKey }, args, VENDOR_API_MAX_CHARS, []);
    default:
      throw new Error(`langfuse integration has no tool ${tool}`);
  }
}

// ---------- atlassian ----------

interface AtlassianCreds {
  site: string;
  email: string;
  token: string;
}

function atlassianCreds(config: Json, secrets: [string, string][]): AtlassianCreds {
  // Site and email are plain settings (config wins, the legacy
  // secret-named rows are the fallback); only the token is a credential.
  const site = configString(config, "site") ?? secretOrNull(secrets, "site");
  if (site === undefined || site === null || site === "") throw new Error("atlassian requires the site setting");
  const email = configString(config, "email") ?? secretOrNull(secrets, "email");
  if (email === undefined || email === null || email === "") throw new Error("atlassian requires the email setting");
  const token = secretOrNull(secrets, "token");
  if (token === null || token === "") throw new Error("atlassian secret 'token' is not stored");
  return { site: trimTrailingSlash(site), email, token };
}

const ATLASSIAN_JIRA_FIELDS = "summary,status,issuetype,assignee,created";

async function atlassianSendJson(url: string, init: RequestInit): Promise<Json> {
  let res: Response;
  try {
    res = await fetch(url, fetchTimeout(CALL_TIMEOUT_MS, init));
  } catch (error) {
    throw new Error(`atlassian unreachable: ${transportCause(error)}`);
  }
  let body: string;
  try {
    body = await res.text();
  } catch {
    throw new Error("atlassian body unreadable");
  }
  if (!res.ok) {
    // A short error body helps diagnosis; Atlassian error messages name
    // the bad JQL/CQL — never credential values.
    throw new Error(`atlassian returned ${res.status}: ${excerpt(body)}`);
  }
  try {
    return JSON.parse(body) as Json;
  } catch {
    throw new Error("atlassian returned bad json");
  }
}

function atlassianAuth(creds: AtlassianCreds): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${creds.email}:${creds.token}`).toString("base64")}` };
}

/** One line of a search result: `KEY — summary [Status] (Assignee)`. */
function jiraLine(issue: Json): string {
  const key = typeof issue["key"] === "string" ? issue["key"] : "?";
  const fields = (issue["fields"] ?? {}) as Json;
  const summary = typeof fields["summary"] === "string" ? fields["summary"] : "";
  const status = (fields["status"] ?? {}) as Json;
  const statusName = typeof status["name"] === "string" ? status["name"] : "";
  const assignee = (fields["assignee"] ?? {}) as Json;
  const assigneeName = typeof assignee["displayName"] === "string" ? assignee["displayName"] : "";
  let line = `${key} — ${summary}`;
  if (statusName !== "") line += ` [${statusName}]`;
  if (assigneeName !== "") line += ` (${assigneeName})`;
  return line;
}

/** Flattens one Jira issue into a readable block with a browse URL. */
function jiraIssueBlock(creds: AtlassianCreds, issue: Json): string {
  const key = typeof issue["key"] === "string" ? issue["key"] : "?";
  const fields = (issue["fields"] ?? {}) as Json;
  const status = (fields["status"] ?? {}) as Json;
  const itype = (fields["issuetype"] ?? {}) as Json;
  const assignee = (fields["assignee"] ?? {}) as Json;
  const statusName = typeof status["name"] === "string" ? status["name"] : "";
  const typeName = typeof itype["name"] === "string" ? itype["name"] : "";
  const assigneeName = typeof assignee["displayName"] === "string" ? assignee["displayName"] : "";
  const created = typeof fields["created"] === "string" ? fields["created"] : "";
  let block = `${key} — ${typeof fields["summary"] === "string" ? fields["summary"] : ""}`;
  const facts: string[] = [];
  if (typeName !== "") facts.push(`type: ${typeName}`);
  if (statusName !== "") facts.push(`status: ${statusName}`);
  if (assigneeName !== "") facts.push(`assignee: ${assigneeName}`);
  if (created !== "") facts.push(`created: ${created}`);
  if (facts.length > 0) block += `\n${facts.join(" | ")}\n`;
  block += `${creds.site}/browse/${key}`;
  return block;
}

/** Strips storage-format XHTML tags and collapses whitespace to plain
 *  text. */
function storageToText(value: string): string {
  let text = "";
  let inTag = false;
  for (const c of value) {
    if (c === "<") {
      // Tag boundaries separate words — keep one space per tag.
      if (!text.endsWith(" ") && text !== "") text += " ";
      inTag = true;
    } else if (c === ">") {
      inTag = false;
    } else if (!inTag) {
      text += c;
    }
  }
  return text.split(/\s+/).filter((s) => s !== "").join(" ");
}

async function atlassianExecute(config: Json, tool: string, args: Json, secrets: [string, string][], _actingAs: string | null): Promise<ToolOutcome> {
  const creds = atlassianCreds(config, secrets);
  const auth = atlassianAuth(creds);
  if (tool === "api") {
    return callVendorApi(creds.site, { kind: "basic", user: creds.email, pass: creds.token }, args, VENDOR_API_MAX_CHARS, []);
  }
  switch (tool) {
    case "jira_search": {
      const jql = args["jql"];
      if (typeof jql !== "string") throw new Error("jira_search requires jql");
      const maxResults = clampNumber(args, "max_results", 10, 50);
      const body = await atlassianSendJson(`${creds.site}/rest/api/3/search/jql`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          jql,
          maxResults,
          fields: ["summary", "status", "issuetype", "assignee"],
        }),
      });
      const issues = Array.isArray(body["issues"]) ? (body["issues"] as Json[]) : [];
      const truncated = issues.length > maxResults;
      let content = issues.slice(0, maxResults).map(jiraLine).join("\n");
      if (content === "") content = "No issues match the query.";
      return {
        content,
        meta: { kind: "jira_search", count: Math.min(issues.length, maxResults), truncated },
      };
    }
    case "jira_get_issue": {
      const key = args["issue_key"];
      if (typeof key !== "string") throw new Error("jira_get_issue requires issue_key");
      const issue = await atlassianSendJson(
        `${creds.site}/rest/api/3/issue/${pathSegment(key)}?fields=${urlencode(ATLASSIAN_JIRA_FIELDS)}`,
        { headers: auth },
      );
      return {
        content: jiraIssueBlock(creds, issue),
        meta: {
          kind: "jira_issue",
          key: issue["key"] ?? null,
          url: `${creds.site}/browse/${typeof issue["key"] === "string" ? issue["key"] : key}`,
        },
      };
    }
    case "confluence_search": {
      const cql = args["cql"];
      if (typeof cql !== "string") throw new Error("confluence_search requires cql");
      const limit = clampNumber(args, "limit", 10, 50);
      const url = new URL(`${creds.site}/wiki/rest/api/search`);
      url.searchParams.set("cql", cql);
      url.searchParams.set("limit", String(limit));
      const resp = await atlassianSendJson(url.toString(), { headers: auth });
      const results = Array.isArray(resp["results"]) ? (resp["results"] as Json[]) : [];
      const truncated = results.length > limit;
      let content = results
        .slice(0, limit)
        .map((r) => {
          const inner = (r["content"] ?? {}) as Json;
          const title = typeof inner["title"] === "string" ? inner["title"] : "(untitled)";
          const id = typeof inner["id"] === "string" ? inner["id"] : "?";
          const excerptText = typeof r["excerpt"] === "string" ? r["excerpt"] : "";
          return excerptText === "" ? `${title} (id ${id})` : `${title} (id ${id}): ${excerptText}`;
        })
        .join("\n");
      if (content === "") content = "No results match the query.";
      return {
        content,
        meta: { kind: "confluence_search", count: Math.min(results.length, limit), truncated },
      };
    }
    case "confluence_get_page": {
      const pageId = args["page_id"];
      if (typeof pageId !== "string") throw new Error("confluence_get_page requires page_id");
      const page = await atlassianSendJson(
        `${creds.site}/wiki/rest/api/content/${pathSegment(pageId)}?expand=${urlencode("body.storage")}`,
        { headers: auth },
      );
      const title = typeof page["title"] === "string" ? page["title"] : "";
      const body = (page["body"] ?? {}) as Json;
      const storage = (body["storage"] ?? {}) as Json;
      const storageValue = typeof storage["value"] === "string" ? storage["value"] : "";
      const links = (page["_links"] ?? {}) as Json;
      const webui = typeof links["webui"] === "string" ? links["webui"] : "";
      let content = title;
      const text = storageToText(storageValue);
      if (text !== "") content += `\n\n${text}`;
      if (webui !== "") content += `\n\n${creds.site}${webui}`;
      return { content, meta: { kind: "confluence_page", id: page["id"] ?? null, title } };
    }
    case "confluence_create_page": {
      const spaceKey = args["space_key"];
      if (typeof spaceKey !== "string") throw new Error("confluence_create_page requires space_key");
      const title = args["title"];
      if (typeof title !== "string") throw new Error("confluence_create_page requires title");
      const value = args["content"];
      if (typeof value !== "string") throw new Error("confluence_create_page requires content");
      const page = await atlassianSendJson(`${creds.site}/wiki/rest/api/content`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({
          type: "page",
          title,
          space: { key: spaceKey },
          body: { storage: { value, representation: "storage" } },
        }),
      });
      const id = typeof page["id"] === "string" ? page["id"] : "";
      const links = (page["_links"] ?? {}) as Json;
      const webui = typeof links["webui"] === "string" ? links["webui"] : "";
      const url = webui === "" ? null : `${creds.site}${webui}`;
      let content = `Created page ${id} (${title})`;
      if (url !== null) content += `\n${url}`;
      const meta: Json = {
        kind: "confluence_page_created",
        id,
        title: typeof page["title"] === "string" ? page["title"] : title,
      };
      if (url !== null) meta["url"] = url;
      return { content, meta };
    }
    default:
      throw new Error(`atlassian integration has no tool ${tool}`);
  }
}

// ---------- slack ----------

function slackBaseUrl(config: Json): string {
  return trimTrailingSlash(configString(config, "base_url") ?? "https://slack.com/api");
}

async function slackApi(url: string, init: RequestInit): Promise<Json> {
  let res: Response;
  try {
    res = await fetch(url, fetchTimeout(LIST_TIMEOUT_MS, init));
  } catch (error) {
    throw new Error(`slack unreachable: ${transportCause(error)}`);
  }
  if (!res.ok) throw new Error(`slack returned ${res.status}`);
  let body: Json;
  try {
    body = (await res.json()) as Json;
  } catch {
    throw new Error("slack returned bad json");
  }
  if (body["ok"] !== true) {
    throw new Error(`slack api error: ${typeof body["error"] === "string" ? body["error"] : "unknown"}`);
  }
  return body;
}

async function slackGet(base: string, botToken: string, endpoint: string, query: [string, string][]): Promise<Json> {
  const url = new URL(`${base}/${endpoint}`);
  for (const [k, v] of query) url.searchParams.set(k, v);
  return slackApi(url.toString(), { method: "GET", headers: { authorization: `Bearer ${botToken}` } });
}

async function slackPost(base: string, botToken: string, endpoint: string, body: Json): Promise<Json> {
  return slackApi(`${base}/${endpoint}`, {
    method: "POST",
    headers: { authorization: `Bearer ${botToken}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function slackJsonText(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

async function slackExecute(config: Json, tool: string, args: Json, secrets: [string, string][], _actingAs: string | null): Promise<ToolOutcome> {
  const base = slackBaseUrl(config);
  if (tool === "api") {
    const token = secret(secrets, "bot_token");
    return callVendorApi(base, { kind: "bearer", token }, args, VENDOR_API_MAX_CHARS, []);
  }
  switch (tool) {
    case "conversations_list": {
      const token = secret(secrets, "bot_token");
      const query: [string, string][] = [
        ["limit", String(clampNumber(args, "limit", 200, 200))],
        ["types", "public_channel,private_channel"],
      ];
      if (typeof args["cursor"] === "string") query.push(["cursor", args["cursor"]]);
      const body = await slackGet(base, token, "conversations.list", query);
      const channels = (Array.isArray(body["channels"]) ? (body["channels"] as Json[]) : []).map((c) => ({
        id: c["id"] ?? null,
        name: c["name"] ?? null,
        is_private: c["is_private"] ?? null,
        is_member: c["is_member"] ?? null,
        topic: ((c["topic"] ?? {}) as Json)["value"] ?? null,
      }));
      // The cursor and has_more ride the content too: the model sees
      // content only, and a multi-page list it cannot page is a silently
      // truncated one.
      const metadata = (body["response_metadata"] ?? {}) as Json;
      return {
        content: slackJsonText({ channels, next_cursor: metadata["next_cursor"] ?? null }),
        meta: { response_metadata: metadata["next_cursor"] ?? null },
      };
    }
    case "conversations_history": {
      const token = secret(secrets, "bot_token");
      const channel = args["channel"];
      if (typeof channel !== "string") throw new Error("conversations_history requires channel");
      const query: [string, string][] = [
        ["channel", channel],
        ["limit", String(clampNumber(args, "limit", 200, 200))],
      ];
      if (typeof args["cursor"] === "string") query.push(["cursor", args["cursor"]]);
      // The bot can enumerate public channels it has not joined
      // (conversations.list shows them workspace-wide), but
      // conversations.history requires membership. On not_in_channel,
      // self-join the public channel and retry once — the join is visible
      // in the workspace (the bot appears in the member list).
      let body: Json;
      try {
        body = await slackGet(base, token, "conversations.history", query);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes("slack api error: not_in_channel")) throw error;
        try {
          await slackPost(base, token, "conversations.join", { channel });
        } catch (joinError) {
          const joinMessage = joinError instanceof Error ? joinError.message : String(joinError);
          throw new Error(`${message} (join attempt failed: ${joinMessage})`);
        }
        try {
          body = await slackGet(base, token, "conversations.history", query);
        } catch (retryError) {
          const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
          throw new Error(`${message} (joined, retry failed: ${retryMessage})`);
        }
      }
      const messages = (Array.isArray(body["messages"]) ? (body["messages"] as Json[]) : []).map((m) => ({
        ts: m["ts"] ?? null,
        user: m["user"] ?? null,
        text: m["text"] ?? null,
      }));
      const metadata = (body["response_metadata"] ?? {}) as Json;
      return {
        content: slackJsonText({ messages, has_more: body["has_more"] === true, next_cursor: metadata["next_cursor"] ?? null }),
        meta: { has_more: body["has_more"] === true, response_metadata: metadata["next_cursor"] ?? null },
      };
    }
    case "users_list": {
      const token = secret(secrets, "bot_token");
      const query: [string, string][] = [["limit", String(clampNumber(args, "limit", 200, 200))]];
      if (typeof args["cursor"] === "string") query.push(["cursor", args["cursor"]]);
      const body = await slackGet(base, token, "users.list", query);
      const users = (Array.isArray(body["members"]) ? (body["members"] as Json[]) : []).map((u) => ({
        id: u["id"] ?? null,
        name: u["name"] ?? null,
        real_name: u["real_name"] ?? null,
        is_bot: u["is_bot"] ?? null,
      }));
      // The cursor rides the content too (the model sees content only — a
      // multi-page list it cannot page is a silently truncated one).
      const metadata = (body["response_metadata"] ?? {}) as Json;
      return {
        content: slackJsonText({ users, next_cursor: metadata["next_cursor"] ?? null }),
        meta: { response_metadata: metadata["next_cursor"] ?? null },
      };
    }
    case "post_message": {
      const token = secret(secrets, "bot_token");
      const channel = args["channel"];
      if (typeof channel !== "string") throw new Error("post_message requires channel");
      const text = args["text"];
      if (typeof text !== "string") throw new Error("post_message requires text");
      const body = await slackPost(base, token, "chat.postMessage", { channel, text });
      return { content: slackJsonText({ channel: body["channel"] ?? null, ts: body["ts"] ?? null }) };
    }
    default:
      throw new Error(`slack integration has no tool ${tool}`);
  }
}

// ---------- github ----------

const GITHUB_DEFAULT_API = "https://api.github.com";
const GITHUB_USER_AGENT = "guild-integration-github";

function githubApiUrl(config: Json): string {
  const v = configString(config, "api_url");
  return v !== undefined ? trimTrailingSlash(v) : GITHUB_DEFAULT_API;
}

/** Maps an HTTP failure to the tool-error contract: auth errors, missing
 *  resources, and validation rejections get specific wording; anything
 *  else carries the status and a body excerpt. */
function githubMapError(status: number, body: string): string {
  const head = excerpt(body);
  switch (status) {
    case 401:
    case 403:
      return `github auth failed (${status})`;
    case 404:
      return "github: not found";
    case 422:
      return `github rejected the request: ${head}`;
    default:
      return `github returned ${status}: ${head}`;
  }
}

interface GithubRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function githubHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    "user-agent": GITHUB_USER_AGENT,
    accept: "application/vnd.github+json",
  };
}

async function githubSend(url: string, init: GithubRequestInit): Promise<Json> {
  let res: Response;
  try {
    res = await fetch(url, fetchTimeout(LIST_TIMEOUT_MS, init as RequestInit));
  } catch (error) {
    throw new Error(`github unreachable: ${transportCause(error)}`);
  }
  const status = res.status;
  let body: string;
  try {
    body = await res.text();
  } catch {
    throw new Error("github returned an unreadable body");
  }
  if (!(status >= 200 && status < 300)) {
    throw new Error(githubMapError(status, body));
  }
  try {
    return JSON.parse(body) as Json;
  } catch {
    throw new Error("github returned bad json");
  }
}

/** The contents-API path for one file: owner/repo as encoded segments, and
 *  the file path as `/`-separated encoded parts — a `..` segment is
 *  rejected (it traverses to another repo path with the org credential). */
function githubFilePath(owner: string, repo: string, filePath: string): string {
  const parts = filePath
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p !== "")
    .map((p) => pathSegment(p));
  return `/repos/${pathSegment(owner)}/${pathSegment(repo)}/contents/${parts.join("/")}`;
}

function githubRepoLine(i: number, hit: Json): string {
  const fullName = typeof hit["full_name"] === "string" ? hit["full_name"] : "(unnamed)";
  const url = typeof hit["html_url"] === "string" ? hit["html_url"] : "";
  const language = typeof hit["language"] === "string" ? hit["language"] : "";
  const stars = typeof hit["stargazers_count"] === "number" ? hit["stargazers_count"] : 0;
  const description = typeof hit["description"] === "string" ? hit["description"] : "";
  return `${i + 1}. ${fullName} (${language === "" ? "?" : language}, ★${stars}) ${url}\n   ${description}\n`;
}

async function githubExecute(config: Json, tool: string, args: Json, secrets: [string, string][], _actingAs: string | null): Promise<ToolOutcome> {
  const token = secretOrNull(secrets, "token");
  if (token === null) throw new Error("github secret 'token' is not stored");
  const api = githubApiUrl(config);
  if (tool === "api") {
    return callVendorApi(api, { kind: "bearer", token }, args, VENDOR_API_MAX_CHARS, [
      ["User-Agent", GITHUB_USER_AGENT],
      ["Accept", "application/vnd.github+json"],
    ]);
  }
  switch (tool) {
    case "search_repositories": {
      const query = args["query"];
      if (typeof query !== "string") throw new Error("search_repositories requires query");
      const perPage = clampNumber(args, "per_page", 10, 50);
      const url = new URL(`${api}/search/repositories`);
      url.searchParams.set("q", query);
      url.searchParams.set("per_page", String(perPage));
      const body = await githubSend(url.toString(), { method: "GET", headers: githubHeaders(token) });
      const hits = Array.isArray(body["items"]) ? (body["items"] as Json[]) : [];
      let content = hits.map((hit, i) => githubRepoLine(i, hit)).join("");
      if (content === "") content = "No repositories matched.";
      return {
        content,
        meta: {
          kind: "github",
          search: "repositories",
          total_count: typeof body["total_count"] === "number" ? body["total_count"] : hits.length,
        },
      };
    }
    case "list_issues": {
      const owner = args["owner"];
      if (typeof owner !== "string") throw new Error("list_issues requires owner");
      const repo = args["repo"];
      if (typeof repo !== "string") throw new Error("list_issues requires repo");
      const state = typeof args["state"] === "string" ? args["state"] : "open";
      const perPage = clampNumber(args, "per_page", 20, 50);
      const url = new URL(`${api}/repos/${pathSegment(owner)}/${pathSegment(repo)}/issues`);
      url.searchParams.set("state", state);
      url.searchParams.set("per_page", String(perPage));
      const body = await githubSend(url.toString(), { method: "GET", headers: githubHeaders(token) });
      const issues = Array.isArray(body) ? body : [];
      let content = "";
      for (const issue of issues) {
        // GitHub returns pull requests here too — skip them.
        if (issue["pull_request"] !== null && typeof issue["pull_request"] === "object") continue;
        const number = typeof issue["number"] === "number" ? issue["number"] : 0;
        const title = typeof issue["title"] === "string" ? issue["title"] : "";
        const issueState = typeof issue["state"] === "string" ? issue["state"] : "?";
        const author = ((issue["user"] ?? {}) as Json)["login"];
        content += `#${number} [${issueState}] ${title} (@${typeof author === "string" ? author : "?"})\n`;
      }
      if (content === "") content = "No issues.";
      return { content };
    }
    case "list_pulls": {
      const owner = args["owner"];
      if (typeof owner !== "string") throw new Error("list_pulls requires owner");
      const repo = args["repo"];
      if (typeof repo !== "string") throw new Error("list_pulls requires repo");
      const state = typeof args["state"] === "string" ? args["state"] : "open";
      const perPage = clampNumber(args, "per_page", 20, 50);
      const url = new URL(`${api}/repos/${pathSegment(owner)}/${pathSegment(repo)}/pulls`);
      url.searchParams.set("state", state);
      url.searchParams.set("per_page", String(perPage));
      const body = await githubSend(url.toString(), { method: "GET", headers: githubHeaders(token) });
      const pulls = Array.isArray(body) ? body : [];
      let content = "";
      for (const pr of pulls) {
        const number = typeof pr["number"] === "number" ? pr["number"] : 0;
        const title = typeof pr["title"] === "string" ? pr["title"] : "";
        const prState = typeof pr["state"] === "string" ? pr["state"] : "?";
        const head = (((pr["head"] ?? {}) as Json)["ref"] ?? "?") as string;
        const base = (((pr["base"] ?? {}) as Json)["ref"] ?? "?") as string;
        const author = ((pr["user"] ?? {}) as Json)["login"];
        content += `#${number} [${prState}] ${title} (${typeof head === "string" ? head : "?"}→${typeof base === "string" ? base : "?"}, @${typeof author === "string" ? author : "?"})\n`;
      }
      if (content === "") content = "No pull requests.";
      return { content };
    }
    case "get_file": {
      const owner = args["owner"];
      if (typeof owner !== "string") throw new Error("get_file requires owner");
      const repo = args["repo"];
      if (typeof repo !== "string") throw new Error("get_file requires repo");
      const filePath = args["path"];
      if (typeof filePath !== "string") throw new Error("get_file requires path");
      const url = new URL(`${api}${githubFilePath(owner, repo, filePath)}`);
      if (typeof args["ref"] === "string") url.searchParams.set("ref", args["ref"]);
      const entry = await githubSend(url.toString(), { method: "GET", headers: githubHeaders(token) });
      // GitHub nulls `content` for files above the contents-API size cap;
      // `encoding` is base64 for regular files.
      const encoded = typeof entry["content"] === "string" ? entry["content"] : null;
      const encoding = typeof entry["encoding"] === "string" ? entry["encoding"] : null;
      let text: string;
      if (encoding === "base64" && encoded !== null) {
        try {
          const bytes = Buffer.from(encoded.replace(/\n/g, ""), "base64");
          text = bytes.toString("utf8");
          if (Buffer.from(text, "utf8").equals(bytes) === false) {
            throw new Error("github file is not utf-8 text");
          }
        } catch (error) {
          if (error instanceof Error && error.message === "github file is not utf-8 text") throw error;
          throw new Error(`github file undecodable: ${(error as Error).message}`);
        }
      } else if (encoding === "none" && encoded !== null) {
        text = encoded;
      } else {
        throw new Error("github file too large for the contents API");
      }
      return {
        content: text,
        meta: { kind: "github", file: typeof entry["path"] === "string" ? entry["path"] : filePath },
      };
    }
    case "create_issue": {
      const owner = args["owner"];
      if (typeof owner !== "string") throw new Error("create_issue requires owner");
      const repo = args["repo"];
      if (typeof repo !== "string") throw new Error("create_issue requires repo");
      const title = args["title"];
      if (typeof title !== "string") throw new Error("create_issue requires title");
      const payload: Json = { title };
      if (typeof args["body"] === "string") payload["body"] = args["body"];
      if (Array.isArray(args["labels"])) payload["labels"] = args["labels"];
      const url = `${api}/repos/${pathSegment(owner)}/${pathSegment(repo)}/issues`;
      let res: Response;
      try {
        res = await fetch(url, fetchTimeout(LIST_TIMEOUT_MS, {
          method: "POST",
          headers: { ...githubHeaders(token), "content-type": "application/json" },
          body: JSON.stringify(payload),
        }));
      } catch (error) {
        throw new Error(`github unreachable: ${transportCause(error)}`);
      }
      const status = res.status;
      let text: string;
      try {
        text = await res.text();
      } catch {
        throw new Error("github returned an unreadable body");
      }
      if (!(status >= 200 && status < 300)) throw new Error(githubMapError(status, text));
      let body: Json;
      try {
        body = JSON.parse(text) as Json;
      } catch {
        throw new Error("github returned bad json");
      }
      const number = typeof body["number"] === "number" ? body["number"] : 0;
      const issueUrl = typeof body["html_url"] === "string" ? body["html_url"] : "";
      return {
        content: `Created issue #${number}: ${issueUrl}`,
        meta: { number, url: issueUrl },
      };
    }
    default:
      throw new Error(`github integration has no tool ${tool}`);
  }
}

// ---------- gitlab ----------

const GITLAB_DEFAULT_API = "https://gitlab.com/api/v4";

function gitlabBaseUrl(config: Json): string {
  const raw = configString(config, "base_url");
  const trimmed = raw !== undefined ? raw.trim().replace(/\/+$/, "") : null;
  if (trimmed === null || trimmed === "") return GITLAB_DEFAULT_API;
  // has_url_path: a string without `://` always counts as carrying a path;
  // a URL whose authority is followed by `/…` keeps its path as-is, a bare
  // host gains the /api/v4 prefix.
  const schemeSplit = trimmed.split("://");
  const hasUrlPath = schemeSplit.length === 1 ? true : schemeSplit[1]!.includes("/");
  return hasUrlPath ? trimmed : `${trimmed}/api/v4`;
}

/** Maps an HTTP failure to the tool-error contract: auth errors, missing
 *  resources, and validation rejections get specific wording; anything
 *  else carries the status and a body excerpt. */
function gitlabMapError(status: number, body: string): string {
  const head = excerpt(body);
  switch (status) {
    case 401:
      return "gitlab auth failed (401)";
    case 404:
      return "gitlab: not found (project or resource)";
    case 400:
      return `gitlab rejected the request: ${head}`;
    default:
      return `gitlab returned ${status}: ${head}`;
  }
}

async function gitlabSend(url: string, init: RequestInit): Promise<Json> {
  let res: Response;
  try {
    res = await fetch(url, fetchTimeout(LIST_TIMEOUT_MS, init));
  } catch (error) {
    throw new Error(`gitlab unreachable: ${transportCause(error)}`);
  }
  const status = res.status;
  let body: string;
  try {
    body = await res.text();
  } catch {
    throw new Error("gitlab returned an unreadable body");
  }
  if (!(status >= 200 && status < 300)) {
    throw new Error(gitlabMapError(status, body));
  }
  try {
    return JSON.parse(body) as Json;
  } catch {
    throw new Error("gitlab returned bad json");
  }
}

function gitlabGet(base: string, token: string, path: string, query: [string, string][]): Promise<Json> {
  const url = new URL(`${base}${path}`);
  for (const [k, v] of query) url.searchParams.set(k, v);
  return gitlabSend(url.toString(), { method: "GET", headers: { "PRIVATE-TOKEN": token } });
}

async function gitlabExecute(config: Json, tool: string, args: Json, secrets: [string, string][], _actingAs: string | null): Promise<ToolOutcome> {
  const token = secretOrNull(secrets, "token");
  if (token === null) throw new Error("gitlab secret 'token' is not stored");
  const base = gitlabBaseUrl(config);
  if (tool === "api") {
    return callVendorApi(base, { kind: "private_token", token }, args, VENDOR_API_MAX_CHARS, []);
  }
  switch (tool) {
    case "list_projects": {
      const search = typeof args["search"] === "string" ? args["search"] : "";
      const perPage = clampNumber(args, "per_page", 20, 50);
      const query: [string, string][] = [
        ["membership", "true"],
        ["order_by", "last_activity_at"],
        ["per_page", String(perPage)],
      ];
      if (search !== "") query.push(["search", search]);
      const body = await gitlabGet(base, token, "/projects", query);
      const projects = Array.isArray(body) ? body : [];
      let content = "";
      for (const [i, project] of projects.entries()) {
        const name = typeof project["name"] === "string" ? project["name"] : "(unnamed)";
        const path = typeof project["path_with_namespace"] === "string" ? project["path_with_namespace"] : "";
        const url = typeof project["web_url"] === "string" ? project["web_url"] : "";
        const description = typeof project["description"] === "string" ? project["description"] : "";
        content += `${i + 1}. ${name} (${path}) ${url}\n   ${description}\n`;
      }
      if (content === "") content = "No projects.";
      return { content };
    }
    case "list_issues": {
      const project = args["project"];
      if (typeof project !== "string") throw new Error("list_issues requires project");
      const state = typeof args["state"] === "string" ? args["state"] : "opened";
      const perPage = clampNumber(args, "per_page", 20, 50);
      const body = await gitlabGet(base, token, `/projects/${pathSegment(project)}/issues`, [
        ["state", state],
        ["per_page", String(perPage)],
      ]);
      const issues = Array.isArray(body) ? body : [];
      let content = "";
      for (const issue of issues) {
        const iid = typeof issue["iid"] === "number" ? issue["iid"] : 0;
        const title = typeof issue["title"] === "string" ? issue["title"] : "";
        const state = typeof issue["state"] === "string" ? issue["state"] : "?";
        const author = ((issue["author"] ?? {}) as Json)["username"];
        content += `!${iid} [${state}] ${title} (@${typeof author === "string" ? author : "?"})\n`;
      }
      if (content === "") content = "No issues.";
      return { content };
    }
    case "list_mrs": {
      const project = args["project"];
      if (typeof project !== "string") throw new Error("list_mrs requires project");
      const state = typeof args["state"] === "string" ? args["state"] : "opened";
      const perPage = clampNumber(args, "per_page", 20, 50);
      const body = await gitlabGet(base, token, `/projects/${pathSegment(project)}/merge_requests`, [
        ["state", state],
        ["per_page", String(perPage)],
      ]);
      const mrs = Array.isArray(body) ? body : [];
      let content = "";
      for (const mr of mrs) {
        const iid = typeof mr["iid"] === "number" ? mr["iid"] : 0;
        const title = typeof mr["title"] === "string" ? mr["title"] : "";
        const state = typeof mr["state"] === "string" ? mr["state"] : "?";
        const source = typeof mr["source_branch"] === "string" ? mr["source_branch"] : "?";
        const target = typeof mr["target_branch"] === "string" ? mr["target_branch"] : "?";
        const author = ((mr["author"] ?? {}) as Json)["username"];
        content += `!${iid} [${state}] ${title} (${source}→${target}, @${typeof author === "string" ? author : "?"})\n`;
      }
      if (content === "") content = "No merge requests.";
      return { content };
    }
    case "create_issue": {
      const project = args["project"];
      if (typeof project !== "string") throw new Error("create_issue requires project");
      const title = args["title"];
      if (typeof title !== "string") throw new Error("create_issue requires title");
      const payload: Json = { title };
      if (typeof args["description"] === "string") payload["description"] = args["description"];
      const body = await gitlabSend(`${base}/projects/${pathSegment(project)}/issues`, {
        method: "POST",
        headers: { "PRIVATE-TOKEN": token, "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const iid = typeof body["iid"] === "number" ? body["iid"] : 0;
      const url = typeof body["web_url"] === "string" ? body["web_url"] : "";
      return {
        content: `Created issue !${iid}: ${url}`,
        meta: { iid, url },
      };
    }
    default:
      throw new Error(`gitlab integration has no tool ${tool}`);
  }
}

// ---------- the plugin dispatcher (call_plugin) ----------

/** Per-connector dispatch, resolved from the compiled-in catalog names. */
function builtinExecute(slug: string): ((config: Json, tool: string, args: Json, secrets: [string, string][], actingAs: string | null) => Promise<ToolOutcome>) | undefined {
  switch (slug) {
    case "searxng": return searxngExecute;
    case "superproxy": return superproxyExecute;
    case "firecrawl": return firecrawlExecute;
    case "google_workspace": return googleWorkspaceExecute;
    case "hubspot": return hubspotExecute;
    case "langfuse": return langfuseExecute;
    case "atlassian": return atlassianExecute;
    case "slack": return slackExecute;
    case "github": return githubExecute;
    case "gitlab": return gitlabExecute;
    default: return undefined;
  }
}

/** Runs one tool on a compiled-in connector directly (the script API and
 *  tests dispatch through callPlugin; this is the raw connector surface). */
export async function executeConnectorTool(
  slug: string,
  config: Json,
  tool: string,
  args: Json,
  secrets: [string, string][],
  actingAs: string | null,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  signal?.throwIfAborted();
  const execute = builtinExecute(slug);
  if (execute === undefined) throw new Error(`unknown integration ${slug}`);
  return callSignals.run(signal, () => execute(config, tool, args, secrets, actingAs));
}

/** Secrets the connector needs — the resolved store values ride only to
 *  execute(); the names come from the turn snapshot's declared list. */
export interface PluginCallIdentity {
  orgId: string;
  callerId: string;
  callId: string;
  actingAs: string | null;
}

/** The narrow store surface the dispatcher re-resolves secrets through
 *  (structurally the GatewayCtx slice; no store values ride the snapshot). */
export interface PluginSecretSource {
  integrationSecrets: {
    names(orgId: string, integration: string): Promise<string[]>;
    resolve(orgId: string, integration: string, names: string[], masterKey: Buffer): Promise<[string, string][]>;
  };
  masterKey(): Buffer;
}

/** Executes one call against a resolved plugin (call_plugin): re-resolves
 *  the secrets (snapshots never
 *  carry values), then runs the built-in connector directly or connects to
 *  the MCP server with the identity envelope and calls the raw tool name. */
export async function callPlugin(
  source: PluginSecretSource,
  turn: PluginTurn,
  rawTool: string,
  args: Json,
  identity: PluginCallIdentity,
  signal?: AbortSignal,
): Promise<ToolOutcome> {
  signal?.throwIfAborted();
  const masterKey = source.masterKey();
  if (turn.executor === "rust") {
    const execute = builtinExecute(turn.slug);
    if (execute === undefined) throw new Error(`unknown integration ${turn.slug}`);
    // Every stored secret of the slug rides to execute — the connector
    // picks what it needs (superproxy's optional gateway token included);
    // values never reach logs or events.
    const names = await source.integrationSecrets.names(identity.orgId, turn.slug);
    const secrets = await source.integrationSecrets.resolve(identity.orgId, turn.slug, names, masterKey);
    signal?.throwIfAborted();
    return callSignals.run(signal, () => execute(turn.rowConfig, rawTool, args, secrets, identity.actingAs));
  }
  // MCP plugin: a short-lived call connection keeps caller and call ID
  // exact (the Rust pool's per-call connect).
  const secrets = await source.integrationSecrets.resolve(identity.orgId, turn.slug, turn.secretNames, masterKey);
  const url = (turn.rowConfig as Json)["mcp"];
  const mcpUrl = url !== null && typeof url === "object" ? (url as Json)["url"] : undefined;
  if (typeof mcpUrl !== "string") throw new Error("mcp url missing");
  const headers = envelopeHeaders(identity.callId, identity.orgId, identity.callerId, identity.actingAs, secrets);
  let peer: McpPeer;
  try {
    peer = await mcpConnect(mcpUrl, headers, signal);
  } catch (error) {
    throw new Error(`integration ${turn.slug} unreachable: ${(error as Error).message}`);
  }
  let result;
  try {
    result = await peer.callTool(rawTool, args);
  } catch (error) {
    throw new Error((error as Error).message);
  }
  if (result.isError) {
    throw new Error(`mcp tool error: ${result.content}`);
  }
  return { content: result.content };
}

export const EXECUTE_TIMEOUTS = { CALL_TIMEOUT_MS, LIST_TIMEOUT_MS, API_TIMEOUT_MS };
