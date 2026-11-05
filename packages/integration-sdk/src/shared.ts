// The connector runtime's shared surface: the tool outcome shape and the
// request helpers every integration builds on, the generic `api` tool's
// call (call_vendor_api) included. A connector failure is a tool RESULT (the error text
// the model sees), never a thrown HTTP error.

import { AsyncLocalStorage } from "node:async_hooks";

export interface ToolOutcome {
  content: string;
  meta?: unknown;
  /** Binary payload the tool hands the model as a spilled artifact: the
   *  caller materializes the bytes and replaces `content` with the pointer
   *  text (chat path). The script API drops the payload. */
  artifact?: { filename: string; contentType: string; bytes: Buffer };
}

/** A decoded JSON object: tool arguments, configs and vendor payloads
 *  across the connector and harness tool runtimes. */
export type JsonObject = Record<string, unknown>;

export const CALL_TIMEOUT_MS = 20_000;
export const LIST_TIMEOUT_MS = 30_000;
export const API_TIMEOUT_MS = 60_000;
export const FETCH_TIMEOUT_MS = 60_000;
export const MAX_BODY_CHARS = 8_000;
export const API_MAX_CHARS = 1_024 * 1_024;
export const VENDOR_API_MAX_CHARS = 12_000;
export const MAX_BODY_SNIPPET = 300;

export function secret(secrets: [string, string][], name: string): string {
  const found = secrets.find(([n]) => n === name);
  if (found === undefined) throw new Error(`secret ${name} is not stored`);
  return found[1];
}

export function secretOrNull(secrets: [string, string][], name: string): string | null {
  const found = secrets.find(([n]) => n === name);
  return found === undefined ? null : found[1];
}

export function configString(config: JsonObject, name: string): string | undefined {
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
      (b >= 0x41 && b <= 0x5a) ||
      (b >= 0x61 && b <= 0x7a) ||
      (b >= 0x30 && b <= 0x39) ||
      b === 0x2d ||
      b === 0x5f ||
      b === 0x2e ||
      b === 0x7e
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
  return error instanceof Error ? (error.cause instanceof Error ? error.cause.message : error.message) : String(error);
}

/** Char-bounded head of an error body (byte slicing would cut a multibyte
 *  character in half). */
export function excerpt(text: string, max = MAX_BODY_SNIPPET): string {
  return [...text].slice(0, max).join("");
}

/** Largest vendor response body read into memory. A JSON body past it is an
 *  error; a text body is cut there. */
export const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/** Reads a response body as raw bytes, at most `maxBytes`. A longer body is
 *  cut there, the rest is cancelled unread, and `truncated` is set. */
export async function readBodyBytesCapped(
  res: Response,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<{ bytes: Buffer; truncated: boolean }> {
  if (res.body === null) return { bytes: Buffer.alloc(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (size + value.byteLength > maxBytes) {
        chunks.push(value.subarray(0, maxBytes - size));
        size = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    if (truncated) await reader.cancel().catch(() => {});
    else reader.releaseLock();
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

/** Reads a response body as UTF-8, at most `maxBytes`. A longer body is cut
 *  there, the rest is cancelled unread, and `truncated` is set. */
export async function readBodyCapped(
  res: Response,
  maxBytes = MAX_RESPONSE_BYTES,
): Promise<{ text: string; truncated: boolean }> {
  const { bytes, truncated } = await readBodyBytesCapped(res, maxBytes);
  return { text: new TextDecoder().decode(bytes), truncated };
}

/** The error text one vendor gives each failure of a JSON request. */
export interface JsonRequestErrors {
  unreachable(cause: string): string;
  unreadable(cause: string): string;
  status(status: number, body: string): string;
  badJson(body: string, error: Error): string;
}

/** The default wording: `<api> unreachable`, `<api> returned <status>: …`. */
export function jsonErrors(api: string): JsonRequestErrors {
  return {
    unreachable: (cause) => `${api} unreachable: ${cause}`,
    unreadable: (cause) => `${api} returned unreadable body: ${cause}`,
    status: (status, body) => `${api} returned ${status}: ${excerpt(body)}`,
    badJson: (_body, error) => `${api} returned bad json: ${error.message}`,
  };
}

/** One JSON request: the timeout and call signal, a bounded body read, and
 *  the vendor's wording for each failure. `emptyBody` is what an empty 2xx
 *  body parses as (absent: an empty body is bad json). */
export async function requestJson(
  url: string | URL,
  init: RequestInit,
  timeoutMs: number,
  errors: JsonRequestErrors,
  options: { emptyBody?: JsonObject } = {},
): Promise<JsonObject> {
  let res: Response;
  try {
    res = await fetch(url, fetchTimeout(timeoutMs, init));
  } catch (error) {
    throw new Error(errors.unreachable(transportCause(error)));
  }
  let body: { text: string; truncated: boolean };
  try {
    body = await readBodyCapped(res);
  } catch (error) {
    throw new Error(errors.unreadable(transportCause(error)));
  }
  if (!res.ok) throw new Error(errors.status(res.status, body.text));
  if (body.truncated) throw new Error(errors.unreadable(`body exceeds ${MAX_RESPONSE_BYTES} bytes`));
  if (body.text === "" && options.emptyBody !== undefined) return options.emptyBody;
  try {
    return JSON.parse(body.text) as JsonObject;
  } catch (error) {
    throw new Error(errors.badJson(body.text, error as Error));
  }
}

export async function fetchJson(
  url: string,
  init: RequestInit,
  api: string,
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<JsonObject> {
  return requestJson(url, init, timeoutMs, jsonErrors(api));
}

/** One binary request: the timeout and call signal, a bounded body, and the
 *  `<api>` wording for each failure. `maxBytes` is a hard cap — a longer body
 *  is an error, never a cut file. */
export async function fetchBytes(
  url: string,
  init: RequestInit,
  api: string,
  maxBytes = MAX_RESPONSE_BYTES,
  timeoutMs = CALL_TIMEOUT_MS,
): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(url, fetchTimeout(timeoutMs, init));
  } catch (error) {
    throw new Error(`${api} unreachable: ${transportCause(error)}`);
  }
  if (!res.ok) {
    const body = await readBodyCapped(res);
    throw new Error(`${api} returned ${res.status}: ${excerpt(body.text)}`);
  }
  let bytes: Buffer;
  let truncated: boolean;
  try {
    ({ bytes, truncated } = await readBodyBytesCapped(res, maxBytes));
  } catch (error) {
    throw new Error(`${api} body unreadable: ${transportCause(error)}`);
  }
  if (truncated) throw new Error(`${api} response exceeds ${maxBytes} bytes`);
  return bytes;
}

export function clampNumber(args: JsonObject, name: string, dflt: number, cap: number): number {
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
export async function callVendorApi(
  base: string,
  auth: ApiAuth,
  args: JsonObject,
  maxChars: number,
  extraHeaders: [string, string][] = [],
): Promise<ToolOutcome> {
  const path = args["path"];
  if (typeof path !== "string") throw new Error("api requires path (starting with /)");
  if (!path.startsWith("/")) throw new Error("api path must start with /");
  const rawMethod = typeof args["method"] === "string" ? args["method"].toUpperCase() : "GET";
  if (!["GET", "POST", "PATCH", "PUT", "DELETE"].includes(rawMethod)) {
    throw new Error(`api method ${rawMethod} not allowed`);
  }
  const headers: Record<string, string> = {};
  if (auth.kind === "bearer") headers["authorization"] = `Bearer ${auth.token}`;
  else if (auth.kind === "basic")
    headers["authorization"] = `Basic ${Buffer.from(`${auth.user}:${auth.pass}`).toString("base64")}`;
  else headers["PRIVATE-TOKEN"] = auth.token;
  for (const [name, value] of extraHeaders) headers[name] = value;
  const url = new URL(`${base}${path}`);
  const query = args["query"];
  if (query !== null && typeof query === "object" && !Array.isArray(query)) {
    for (const [k, v] of Object.entries(query as JsonObject)) {
      url.searchParams.set(k, typeof v === "string" ? v : (JSON.stringify(v) ?? ""));
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
    // A UTF-8 character is at most four bytes: this cap never cuts text the
    // char truncation below would keep.
    ({ text } = await readBodyCapped(res, Math.min(MAX_RESPONSE_BYTES, maxChars * 4 + 4)));
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
