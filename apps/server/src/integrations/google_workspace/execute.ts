import { createHash, createSign } from "node:crypto";
import { CALL_TIMEOUT_MS, MAX_BODY_CHARS, API_MAX_CHARS, secret, configString, urlencode, fetchTimeout, transportCause, fetchJson, clampNumber, callVendorApi, googleApiBase, googleTokenUrl } from "../shared.js";
import type { ToolOutcome, JsonObject } from "../shared.js";

// ---------- google_workspace ----------

const GOOGLE_SCOPES =
  "https://www.googleapis.com/auth/gmail.readonly " +
  "https://www.googleapis.com/auth/calendar.readonly " +
  "https://www.googleapis.com/auth/drive.readonly " +
  "https://www.googleapis.com/auth/admin.directory.user.readonly";
const GOOGLE_JWT_TTL_SECS = 3600;
/** A cached access token refreshes this long before its own expiry. */
const GOOGLE_EXPIRY_MARGIN_MS = 60_000;

interface CachedGoogleToken {
  token: string;
  expiresAtMs: number;
}

/** Access tokens keyed by `token_url|client_email|subject|secret
 *  fingerprint` — one entry per acting identity AND credential, shared
 *  across calls in this process. */
const googleTokens = new Map<string, CachedGoogleToken>();

function googleServiceAccount(secrets: [string, string][]): { clientEmail: string; privateKey: string } {
  const raw = secret(secrets, "service_account_json");
  let parsed: JsonObject;
  try {
    parsed = JSON.parse(raw) as JsonObject;
  } catch (error) {
    throw new Error(`service_account_json is not valid json: ${(error as Error).message}`);
  }
  const clientEmail = parsed["client_email"];
  if (typeof clientEmail !== "string") throw new Error("service_account_json missing client_email");
  const privateKey = parsed["private_key"];
  if (typeof privateKey !== "string") throw new Error("service_account_json missing private_key");
  return { clientEmail, privateKey };
}

function googleAdminEmail(config: JsonObject, secrets: [string, string][]): string {
  const fromConfig = configString(config, "admin_email");
  if (fromConfig !== undefined) return fromConfig;
  return secret(secrets, "admin_email");
}

/** Acting identity for the `sub` claim: the call's `acting_as` value when
 *  present, else the `admin_email` default subject. */
function googleActingIdentity(actingAs: string | null, adminEmail: string): string {
  return actingAs ?? adminEmail;
}

async function googleAccessToken(config: JsonObject, secrets: [string, string][], sub: string): Promise<string> {
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
  let body: JsonObject;
  try {
    body = (await res.json()) as JsonObject;
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

export async function googleAccessTokenFor(config: JsonObject, secrets: [string, string][], actingAs: string | null): Promise<string> {
  return googleAccessToken(config, secrets, googleActingIdentity(actingAs, googleAdminEmail(config, secrets)));
}

async function googleGetJson(url: string, token: string, api: string): Promise<JsonObject> {
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
function extractBody(payload: JsonObject): string | null {
  const mime = typeof payload["mimeType"] === "string" ? payload["mimeType"] : "";
  const body = payload["body"];
  const data = body !== null && typeof body === "object" && typeof (body as JsonObject)["data"] === "string"
    ? (body as JsonObject)["data"] as string
    : null;
  if (data !== null) {
    const bytes = decodeBodyPartBytes(data);
    const text = bytes !== null && isUtf8(bytes) ? bytes.toString("utf8") : null;
    if (text !== null) {
      if (mime === "text/plain") return text;
      if (mime === "text/html") return stripHtmlTags(text);
    }
  }
  const parts = Array.isArray(payload["parts"]) ? (payload["parts"] as JsonObject[]) : null;
  if (parts !== null) {
    for (const part of parts) {
      const found = extractBody(part);
      if (found !== null) return found;
    }
  }
  return null;
}

function headerValue(payload: JsonObject, name: string): string | null {
  const headers = Array.isArray(payload["headers"]) ? (payload["headers"] as JsonObject[]) : [];
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
function attachmentParts(payload: JsonObject): [string, string, string][] {
  const out: [string, string, string][] = [];
  const walk = (part: JsonObject): void => {
    const body = part["body"];
    const id = body !== null && typeof body === "object" && typeof (body as JsonObject)["attachmentId"] === "string"
      ? (body as JsonObject)["attachmentId"] as string
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
    const parts = Array.isArray(part["parts"]) ? (part["parts"] as JsonObject[]) : [];
    for (const child of parts) walk(child);
  };
  walk(payload);
  return out;
}

async function gmailSearch(config: JsonObject, args: JsonObject, token: string): Promise<ToolOutcome> {
  const query = args["query"];
  if (typeof query !== "string") throw new Error("gmail_search requires query");
  const url = `${googleApiBase(config)}/gmail/v1/users/me/messages?q=${urlencode(query)}&maxResults=${clampNumber(args, "max_results", 10, 25)}`;
  const body = await googleGetJson(url, token, "gmail");
  const messages = Array.isArray(body["messages"]) ? (body["messages"] as JsonObject[]) : [];
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

async function gmailGetMessage(config: JsonObject, args: JsonObject, token: string): Promise<ToolOutcome> {
  const id = args["message_id"];
  if (typeof id !== "string") throw new Error("gmail_get_message requires message_id");
  const body = await googleGetJson(`${googleApiBase(config)}/gmail/v1/users/me/messages/${urlencode(id)}`, token, "gmail");
  const payload = (body["payload"] ?? {}) as JsonObject;
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

async function gmailGetAttachment(config: JsonObject, args: JsonObject, token: string): Promise<ToolOutcome> {
  const messageId = args["message_id"];
  if (typeof messageId !== "string") throw new Error("gmail_get_attachment requires message_id");
  const attachmentId = args["attachment_id"];
  if (typeof attachmentId !== "string") throw new Error("gmail_get_attachment requires attachment_id");
  // The attachment endpoint returns only size + base64url data; the part
  // metadata (filename, mime) comes from the message itself.
  const message = await googleGetJson(`${googleApiBase(config)}/gmail/v1/users/me/messages/${urlencode(messageId)}`, token, "gmail");
  const part = attachmentParts((message["payload"] ?? {}) as JsonObject).find(([, , id]) => id === attachmentId);
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

async function calendarListEvents(config: JsonObject, args: JsonObject, token: string): Promise<ToolOutcome> {
  // timeMin defaults to now: without it the API expands recurring events
  // from their first instance and ascending startTime order makes the
  // first page decades of old recurrences instead of upcoming events.
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const timeMin = typeof args["time_min"] === "string" ? args["time_min"] : now;
  let url = `${googleApiBase(config)}/calendar/v3/calendars/primary/events?singleEvents=true&orderBy=startTime&maxResults=${clampNumber(args, "max_results", 10, 50)}&timeMin=${urlencode(timeMin)}`;
  if (typeof args["time_max"] === "string") url += `&timeMax=${urlencode(args["time_max"])}`;
  const body = await googleGetJson(url, token, "calendar");
  const items = Array.isArray(body["items"]) ? (body["items"] as JsonObject[]) : [];
  if (items.length === 0) {
    return { content: "No events in the requested window." };
  }
  let out = `Calendar events: ${items.length}\n`;
  for (const e of items) {
    const start = (e["start"] ?? {}) as JsonObject;
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

async function driveSearch(config: JsonObject, args: JsonObject, token: string): Promise<ToolOutcome> {
  const name = args["name"];
  if (typeof name !== "string") throw new Error("drive_search requires name");
  const url = `${googleApiBase(config)}/drive/v3/files?q=${urlencode(driveNameQuery(name))}&fields=files(id,name,mimeType)&pageSize=${clampNumber(args, "max_results", 10, 50)}`;
  const body = await googleGetJson(url, token, "drive");
  const files = Array.isArray(body["files"]) ? (body["files"] as JsonObject[]) : [];
  if (files.length === 0) {
    return { content: `No Drive files matching "${name}".` };
  }
  let out = `Drive files matching "${name}": ${files.length}\n`;
  for (const f of files) {
    out += `- ${typeof f["name"] === "string" ? f["name"] : "(untitled)"} — ${typeof f["mimeType"] === "string" ? f["mimeType"] : "unknown"} (id ${typeof f["id"] === "string" ? f["id"] : "?"})\n`;
  }
  return { content: out };
}

async function directoryUsers(config: JsonObject, args: JsonObject, secrets: [string, string][], token: string): Promise<ToolOutcome> {
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
  const users = Array.isArray(body["users"]) ? (body["users"] as JsonObject[]) : [];
  if (users.length === 0) {
    return { content: `No directory users in domain "${domain}".` };
  }
  let out = `Directory users (domain ${domain}): ${users.length}\n`;
  for (const u of users) {
    const name = (u["name"] ?? {}) as JsonObject;
    out += `- ${typeof u["primaryEmail"] === "string" ? u["primaryEmail"] : "(no email)"} — ${typeof name["fullName"] === "string" ? name["fullName"] : "(no name)"}\n`;
  }
  return { content: out };
}

export async function googleWorkspaceExecute(config: JsonObject, tool: string, args: JsonObject, secrets: [string, string][], actingAs: string | null): Promise<ToolOutcome> {
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

