// User-owned MCP server surface (session auth only — org API keys never
// mutate): CRUD for the caller's servers plus the probe. The probe connects
// with the stored (decrypted) headers and lists tools; a probe failure is a
// RESULT ({ok:false, error}), HTTP 200 — the same philosophy as
// integration_tools.ts, never an HTTP error.
//
// SSRF guard: URLs whose host is an IP literal in loopback/private/
// link-local ranges (127.0.0.0/8, 10/8, 172.16/12, 192.168/16, 169.254/16,
// ::1, fe80::/10) are rejected unless GUILD_MCP_ALLOW_PRIVATE=1. Only IP
// LITERALS are checked — DNS names are never resolved and never blocked
// (the compose deployment legitimately reaches `host.docker.internal`, a
// name, so the literal check passes it). Header values are encrypted at
// rest and leave the API only as masked previews; decrypted values flow to
// the MCP peer at call time only.

import type { FastifyInstance, FastifyReply } from "fastify";
import { lookup } from "node:dns/promises";
import type { IdentityCtx } from "../contexts.js";
import { ApiError } from "../errors.js";
import { rustJsonText } from "../provider/sse.js";
import { requireUser, parseUuidParam, requireJsonBody } from "./error.js";
import { mcpConnect } from "../integrations/mcp.js";
import { userMcpToolName } from "../domain/mcp.js";

type Json = Record<string, unknown>;

/** Tool names Guild reserves for its own machinery — a user server's name
 *  must not collide with them (the wire tool name is mcp<length>_<name>_<tool>, but
 *  the bare name stays reserved to avoid ambiguity). */
const RESERVED_NAMES = new Set([
  "read", "write", "edit", "bash", "codemode",
  "read_skill", "search_skills", "push_skill", "tool_search",
]);

function sendJson(reply: FastifyReply, value: unknown): void {
  void reply.type("application/json").send(rustJsonText(value));
}
/** The server-name rule: identifier-safe slug, 1–64 chars. The chat runtime
 *  wires tools as mcp<length>_<name>_<tool>, so the name must stay slug-safe. */
export function validateName(name: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(name)) {
    throw ApiError.badRequest("name must match [a-z0-9][a-z0-9_-]{0,63}");
  }
  if (RESERVED_NAMES.has(name)) {
    throw ApiError.badRequest(`name ${name} is reserved`);
  }
  if (name.startsWith("int_")) {
    throw ApiError.badRequest("names starting with int_ are reserved");
  }
}

/** Whether the host string is a private/loopback/link-local IP literal
 *  (IPv4 dotted quad + the ranges below, or IPv6 in brackets or bare). */
export function isPrivateIpLiteral(host: string): boolean {
  const h = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  // IPv4-mapped IPv6 (`::ffff:127.0.0.1`) delegates to the IPv4 rules.
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(h);
  if (mapped !== null) return isPrivateIpLiteral(mapped[1]!);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4 !== null) {
    const [a, b, c] = [Number(v4[1]), Number(v4[2]), Number(v4[3])];
    if ([a, b, c, Number(v4[4])].some((n) => n > 255)) return false;
    if (a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)) return true;
    return false;
  }
  if (h === "::1" || h === "::") return true;
  if (h.includes(":")) {
    // fe80::/10 and fc00::/7: the first hextet decides.
    const first = h.split(":")[0] ?? "";
    const n = parseInt(first, 16);
    if (!Number.isNaN(n) && ((n >= 0xfe80 && n <= 0xfebf) || (n >= 0xfc00 && n <= 0xfdff))) return true;
  }
  return false;
}

/** Hostnames allowed to resolve to a private address. The compose deployment
 *  reaches `host.docker.internal`; anything else must resolve public. */
function allowedPrivateHosts(): Set<string> {
  return new Set(
    (process.env.GUILD_MCP_ALLOWED_HOSTS ?? "host.docker.internal")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s !== ""),
  );
}

/** URL validation: http(s), a host, and the SSRF guard. The guard checks IP
 *  literals and every address the hostname resolves to, so a name that
 *  points at a private service is refused like the literal would be. */
export async function validateUrl(raw: string): Promise<void> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw ApiError.badRequest("url must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw ApiError.badRequest("url must be http(s)");
  }
  if (url.hostname === "") throw ApiError.badRequest("url must carry a host");
  if (process.env.GUILD_MCP_ALLOW_PRIVATE === "1") return;
  if (isPrivateIpLiteral(url.hostname)) {
    throw ApiError.badRequest("private and loopback addresses are not allowed");
  }
  if (allowedPrivateHosts().has(url.hostname.toLowerCase())) return;
  // RFC 2606 reserved names never resolve, so they cannot reach a private
  // service. Tests use them as stand-ins for a real remote host.
  if (/\.(test|example|invalid)$/i.test(url.hostname)) return;
  let addresses: { address: string }[];
  try {
    addresses = await lookup(url.hostname, { all: true, verbatim: true });
  } catch {
    throw ApiError.badRequest("url host does not resolve");
  }
  if (addresses.some((a) => isPrivateIpLiteral(a.address))) {
    throw ApiError.badRequest("private and loopback addresses are not allowed");
  }
}

/** Validates the optional headers object: flat string→string map, header
 *  names non-empty, size bounded. */
export function validateHeaders(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw ApiError.badRequest("headers must be a JSON object of name → value");
  }
  const entries = Object.entries(raw as Json);
  if (entries.length > 32) throw ApiError.badRequest("too many headers");
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (name.trim() === "" || name.length > 128) throw ApiError.badRequest("invalid header name");
    if (typeof value !== "string") throw ApiError.badRequest("header values must be strings");
    if (value.length > 8192) throw ApiError.badRequest("header value too long");
    out[name] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The live tool list of one stored server — the probe and the tools
 *  listing share this path (one code path, two routes). A connect or
 *  list failure is a result ({ok:false, error}), not a thrown error. */
export async function probeServer(
  server: { name: string; url: string; headers?: Record<string, string> },
): Promise<{ ok: true; tools: { name: string; call_name: string; description: string }[] } | { ok: false; error: string }> {
  try {
    const peer = await mcpConnect(server.url, server.headers ?? {}, AbortSignal.timeout(20_000));
    const tools = await peer.listTools();
    return { ok: true, tools: tools.map((t) => ({ name: t.name, call_name: userMcpToolName(server.name, t.name), description: t.description })) };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
}

async function connectionDraft(body: Json): Promise<{ name: string; url: string; headers?: Record<string, string> }> {
  const name = body["name"];
  if (typeof name !== "string") throw ApiError.badRequest("missing name");
  validateName(name);
  const url = body["url"];
  if (typeof url !== "string") throw ApiError.badRequest("missing url");
  await validateUrl(url);
  return { name, url, headers: validateHeaders(body["headers"]) };
}

export function registerUserMcpRoutes(app: FastifyInstance, auth: IdentityCtx): void {
  app.post("/api/v1/mcp/probe", async (req, reply) => {
    await requireUser(auth, req);
    sendJson(reply, await probeServer(await connectionDraft(requireJsonBody(req))));
    return reply;
  });
  // `GET /api/v1/mcp/servers` — the caller's servers (masked headers).
  app.get("/api/v1/mcp/servers", async (req, reply) => {
    const user = await requireUser(auth, req);
    const rows = await auth.userMcp.list(user.org_id, user.id);
    sendJson(reply, {
      servers: rows.map((r) => ({
        id: r.id,
        name: r.name,
        url: r.url,
        enabled: r.enabled,
        created_at: r.created_at,
        updated_at: r.updated_at,
        headers: auth.userMcp.previews(r.headers_enc, auth.masterKey()),
      })),
    });
    return reply;
  });

  // `POST /api/v1/mcp/servers` — create {name, url, headers?, enabled?}.
  app.post("/api/v1/mcp/servers", async (req, reply) => {
    const user = await requireUser(auth, req);
    const body = requireJsonBody(req);
    const { name, url, headers } = await connectionDraft(body);
    const enabled = body["enabled"] === undefined ? true : body["enabled"] === true;
    const existing = await auth.userMcp.list(user.org_id, user.id);
    if (existing.some((r) => r.name === name)) {
      throw ApiError.conflict("name_taken", `a server named ${name} already exists`);
    }
    const row = await auth.userMcp.create(user.org_id, user.id, name, url, headers, enabled, auth.masterKey());
    sendJson(reply, { server: serverView(auth, row) });
    return reply;
  });

  // `PATCH /api/v1/mcp/servers/:id` — any subset of name/url/headers/enabled.
  app.patch("/api/v1/mcp/servers/:id", async (req, reply) => {
    const user = await requireUser(auth, req);
    const id = parseUuidParam(req, "id");
    const body = requireJsonBody(req);
    const patch: { name?: string; url?: string; headers?: Record<string, string>; enabled?: boolean } = {};
    if (body["name"] !== undefined) {
      if (typeof body["name"] !== "string") throw ApiError.badRequest("name must be a string");
      validateName(body["name"]);
      patch.name = body["name"];
    }
    if (body["url"] !== undefined) {
      if (typeof body["url"] !== "string") throw ApiError.badRequest("url must be a string");
      await validateUrl(body["url"]);
      patch.url = body["url"];
    }
    if (body["headers"] !== undefined) patch.headers = validateHeaders(body["headers"]);
    if (body["enabled"] !== undefined) {
      if (typeof body["enabled"] !== "boolean") throw ApiError.badRequest("enabled must be a boolean");
      patch.enabled = body["enabled"];
    }
    if (patch.name !== undefined) {
      const rows = await auth.userMcp.list(user.org_id, user.id);
      if (rows.some((r) => r.id !== id && r.name === patch.name)) {
        throw ApiError.conflict("name_taken", `a server named ${patch.name} already exists`);
      }
    }
    const row = await auth.userMcp.update(user.org_id, user.id, id, patch, auth.masterKey());
    if (row === null) throw ApiError.notFound("no such server");
    sendJson(reply, { server: serverView(auth, row) });
    return reply;
  });

  // `DELETE /api/v1/mcp/servers/:id`.
  app.delete("/api/v1/mcp/servers/:id", async (req, reply) => {
    const user = await requireUser(auth, req);
    const id = parseUuidParam(req, "id");
    const gone = await auth.userMcp.delete(user.org_id, user.id, id);
    if (!gone) throw ApiError.notFound("no such server");
    sendJson(reply, { ok: true });
    return reply;
  });

  // `POST /api/v1/mcp/servers/:id/probe` — live connect + list_tools. The
  // probe failure is a result (HTTP 200, ok:false).
  app.post("/api/v1/mcp/servers/:id/probe", async (req, reply) => {
    const user = await requireUser(auth, req);
    const id = parseUuidParam(req, "id");
    const row = await auth.userMcp.get(user.org_id, user.id, id);
    if (row === null) throw ApiError.notFound("no such server");
    sendJson(reply, await probeServer({ name: row.name, url: row.url, headers: auth.userMcp.resolveHeaders(row.headers_enc, auth.masterKey()) }));
    return reply;
  });

  // `GET /api/v1/mcp/servers/:id/tools` — the same live probe path.
  app.get("/api/v1/mcp/servers/:id/tools", async (req, reply) => {
    const user = await requireUser(auth, req);
    const id = parseUuidParam(req, "id");
    const row = await auth.userMcp.get(user.org_id, user.id, id);
    if (row === null) throw ApiError.notFound("no such server");
    sendJson(reply, await probeServer({ name: row.name, url: row.url, headers: auth.userMcp.resolveHeaders(row.headers_enc, auth.masterKey()) }));
    return reply;
  });
}

/** The masked API view of one row (header names + previews, no values). */
function serverView(
  auth: IdentityCtx,
  row: { id: string; name: string; url: string; enabled: boolean; headers_enc: Buffer | null; created_at: string; updated_at: string },
): Json {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    enabled: row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
    headers: auth.userMcp.previews(row.headers_enc, auth.masterKey()),
  };
}
