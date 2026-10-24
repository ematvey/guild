// The connector runtime's shared surface: the tool outcome shape, the
// request helpers every vendor builds on, and the generic `api` tool
// (call_vendor_api). A connector failure is a tool RESULT (the error text
// the model sees), never a thrown HTTP error.

import { AsyncLocalStorage } from "node:async_hooks";

export interface ToolOutcome {
  content: string;
  meta?: unknown;
  /** Binary payload the tool hands the model as a spilled artifact: the
   *  caller materializes the bytes and replaces `content` with the pointer
   *  text (chat path). The script API drops the payload (as in Rust). */
  artifact?: { filename: string; contentType: string; bytes: Buffer };
}

export type Json = Record<string, unknown>;

export const CALL_TIMEOUT_MS = 20_000;
export const LIST_TIMEOUT_MS = 30_000;
export const API_TIMEOUT_MS = 60_000;
export const FETCH_TIMEOUT_MS = 60_000;
export const MAX_BODY_CHARS = 8_000;
export const API_MAX_CHARS = 1_024 * 1_024;
export const VENDOR_API_MAX_CHARS = 12_000;
export const MAX_BODY_SNIPPET = 300;
export const SCRAPE_EXCERPT_CHARS = 2_000;
export const MAP_LINK_LIMIT = 500;
export const FIRECRAWL_DEFAULT_BASE_URL = "http://host.docker.internal:13002";

export function secret(secrets: [string, string][], name: string): string {
  const found = secrets.find(([n]) => n === name);
  if (found === undefined) throw new Error(`secret ${name} is not stored`);
  return found[1];
}

export function secretOrNull(secrets: [string, string][], name: string): string | null {
  const found = secrets.find(([n]) => n === name);
  return found === undefined ? null : found[1];
}

export function configString(config: Json, name: string): string | undefined {
  const v = config[name];
  return typeof v === "string" ? v : undefined;
}

export function trimTrailingSlash(url: string): string {
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
export function urlencode(value: string): string {
  return pathSegment(value);
}

export const callSignals = new AsyncLocalStorage<AbortSignal | undefined>();

export function fetchTimeout(ms: number, init?: RequestInit): RequestInit {
  const signal = callSignals.getStore();
  signal?.throwIfAborted();
  const signals = [AbortSignal.timeout(ms)];
  if (signal) signals.push(signal);
  if (init?.signal) signals.push(init.signal);
  return { ...init, signal: AbortSignal.any(signals) };
}

export function transportCause(error: unknown): string {
  return error instanceof Error
    ? (error.cause instanceof Error ? error.cause.message : error.message)
    : String(error);
}

/** Char-bounded head of an error body (byte slicing would cut a multibyte
 *  character in half). */
export function excerpt(text: string, max = MAX_BODY_SNIPPET): string {
  return [...text].slice(0, max).join("");
}

export async function fetchJson(url: string, init: RequestInit, api: string, timeoutMs = CALL_TIMEOUT_MS): Promise<Json> {
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

export function clampNumber(args: Json, name: string, dflt: number, cap: number): number {
  const v = args[name];
  const n = typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : dflt;
  return Math.min(Math.max(n, 1), cap);
}

export function truncateWithMarker(text: string, maxChars: number): [string, boolean] {
  const chars = [...text];
  if (chars.length <= maxChars) return [text, false];
  return [`${chars.slice(0, maxChars).join("")}\n\n[truncated]`, true];
}

// ---------- the shared generic `api` tool (call_vendor_api) ----------

export type ApiAuth =
  | { kind: "bearer"; token: string }
  | { kind: "basic"; user: string; pass: string }
  | { kind: "private_token"; token: string };

/** Runs one generic vendor REST call: `path` must start with `/`; the
 *  method is whitelisted; the body rides as JSON when present. The raw
 *  response text is the content, truncated to `max_chars`. */
export async function callVendorApi(base: string, auth: ApiAuth, args: Json, maxChars: number, extraHeaders: [string, string][] = []): Promise<ToolOutcome> {
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
