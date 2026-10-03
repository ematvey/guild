// Error envelope for `/api/v1` (spec §7, crates/server/src/http/error.rs):
// {"error":{"code":"...","message":"..."}} — plus the extractor-rejection
// text bodies axum emits outside the envelope (JSON body parse/deserialize
// and path-param failures), which the Rust server leaks verbatim.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { isUuid } from "../time.js";
import type { UserRow } from "../store/identity.js";
import type { PlatformContext } from "../context.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public message: string,
  ) {
    super(message);
  }

  static badRequest(message: string): ApiError {
    return new ApiError(400, "bad_request", message);
  }

  static unauthorized(message: string): ApiError {
    return new ApiError(401, "unauthorized", message);
  }

  static forbidden(): ApiError {
    return new ApiError(403, "forbidden", "admin role required");
  }

  static notFound(message: string): ApiError {
    return new ApiError(404, "not_found", message);
  }

  static conflict(code: string, message: string): ApiError {
    return new ApiError(409, code, message);
  }

  static internal(message = "internal server error"): ApiError {
    return new ApiError(500, "internal", message);
  }
}

/** Plain-text rejection with an axum-shaped body (extractor failures). */
export class TextError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(body);
  }
}

export const JSON_REJECTION_PREFIX = "Failed to parse the request body as JSON: ";
export const DESERIALIZE_PREFIX = "Failed to deserialize the JSON body into the target type: ";

/** Symbol the JSON content parser uses to attach the raw body text; serde's
 *  column position in deserialize rejections is the raw body length. */
export const RAW_BODY = Symbol("rawBody");

export function missingFieldError(field: string, rawLength: number): TextError {
  return new TextError(
    422,
    `${DESERIALIZE_PREFIX}missing field \`${field}\` at line 1 column ${rawLength}`,
  );
}

/** serde_json error text for a non-string field where a string was expected. */
export function invalidTypeError(value: unknown, rawLength: number): TextError {
  const kind =
    value === null
      ? "null"
      : typeof value === "number"
        ? `integer \`${value}\``
        : typeof value === "boolean"
          ? `boolean \`${value}\``
          : typeof value === "object"
            ? "sequence"
            : `string "${String(value)}"`;
  return new TextError(
    422,
    `${DESERIALIZE_PREFIX}invalid type: ${kind}, expected a string at line 1 column ${rawLength}`,
  );
}

/**
 * serde-style failure text for a path parameter that must parse as a UUID.
 * The common case (a non-hex character) is reproduced verbatim; other
 * malformations get the prefix with a generic suffix.
 */
export function uuidPathError(param: string, value: string): TextError {
  const invalidAt = [...value].findIndex((c) => !/[0-9a-fA-F-]/.test(c));
  const detail =
    invalidAt >= 0
      ? `invalid character: found \`${value[invalidAt]}\` at ${invalidAt}`
      : "unexpected length";
  return new TextError(
    400,
    `Invalid URL: Cannot parse \`${param}\` with value \`${value}\`: UUID parsing failed: ${detail}`,
  );
}

export function parseUuidParam(req: FastifyRequest, param: string): string {
  const value = (req.params as Record<string, string>)[param] ?? "";
  if (!isUuid(value)) throw uuidPathError(param, value);
  return value.toLowerCase();
}

/** The authenticated user from the session table (AuthUser extractor). */
export async function requireUser(
  ctx: PlatformContext,
  req: FastifyRequest,
): Promise<UserRow> {
  const header = req.headers.authorization;
  if (header === undefined) {
    throw ApiError.unauthorized("missing authorization header");
  }
  if (!header.startsWith("Bearer ")) {
    throw ApiError.unauthorized("expected Bearer token");
  }
  return ctx.identity.validateSession(header.slice("Bearer ".length));
}

export function requireAdmin(user: UserRow): UserRow {
  if (user.role !== "admin") throw ApiError.forbidden();
  return user;
}

/**
 * Parses the JSON body like axum's Json extractor: a missing/wrong
 * Content-Type is a 415 text rejection; an unparseable body is a 400 text
 * rejection (the raw body length feeds serde's column position).
 */
export function requireJsonBody(req: FastifyRequest): Record<string, unknown> {
  const contentType = req.headers["content-type"]?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new TextError(415, "Expected request with `Content-Type: application/json`");
  }
  const body = req.body;
  if (body === undefined || body === null || typeof body !== "object") {
    // The custom parser already converts JSON failures to TextError; an
    // empty body with a JSON content-type is the same rejection class.
    throw new TextError(400, `${JSON_REJECTION_PREFIX}EOF while parsing an object at line 1 column 0`);
  }
  return body as Record<string, unknown>;
}

/** Typed-body variant: two required string fields (LoginRequest, ...). */
export function requireStringFields(
  body: Record<string, unknown>,
  fields: [string, ...string[]],
  rawLength: number,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = body[field];
    if (value === undefined) throw missingFieldError(field, rawLength);
    if (typeof value !== "string") throw invalidTypeError(value, rawLength);
    out[field] = value;
  }
  return out;
}

/** Query parameter as a string (Rust Query<HashMap<String, String>>). */
export function queryParam(req: FastifyRequest, name: string): string | undefined {
  const url = new URL(req.url, "http://local");
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}

/** Serializes like serde_json::json! interpolation: BTreeMap key order. */
export function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortedJson((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Installs the platform error handling on the encapsulated scope. */
export function installErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: unknown, req, reply) => {
    if (error instanceof ApiError) {
      if (error.status === 500) req.log.error(error);
      return reply
        .status(error.status)
        .send({ error: { code: error.code, message: error.message } });
    }
    if (error instanceof TextError) {
      return reply.status(error.status).type("text/plain; charset=utf-8").send(error.body);
    }
    const code = (error as { code?: string }).code;
    // fastify content-parser failures (invalid JSON body) — axum renders
    // these as plain text with the parse-failure prefix.
    if (typeof code === "string" && code.startsWith("FST_ERR_CTP_")) {
      req.log.error(error);
      return reply
        .status(400)
        .type("text/plain; charset=utf-8")
        .send(`${JSON_REJECTION_PREFIX}${(error as Error).message}`);
    }
    req.log.error(error);
    return reply
      .status(500)
      .send({ error: { code: "internal", message: "internal server error" } });
  });
  // No custom not-found handler: unmatched methods/paths inside the native
  // route groups must keep falling through to the proxy catch-all (Rust 404
  // envelope), so per-area rollback stays "delete the TS route".
}
