// Transport-level request helpers over the domain error types: the Fastify
// extractions (auth user, JSON body, query/path params) and the error
// handler installation. The wire shapes themselves (ApiError, TextError,
// rejection texts) live in platform/errors.ts — stores and services import
// from there, never from this module.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { isUuid } from "../time.js";
import {
  ApiError,
  TextError,
  JSON_REJECTION_PREFIX,
  invalidTypeError,
  missingFieldError,
  uuidPathError,
} from "../errors.js";
import type { UserRow } from "../store/identity.js";
import type { IdentityCtx } from "../route-contexts.js";

export function parseUuidParam(req: FastifyRequest, param: string): string {
  const value = (req.params as Record<string, string>)[param] ?? "";
  if (!isUuid(value)) throw uuidPathError(param, value);
  return value.toLowerCase();
}

/** The authenticated user from the session table (AuthUser extractor). */
export async function requireUser(
  ctx: IdentityCtx,
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

/** Installs the error handling on the encapsulated scope. `renderApiError`
 *  lets non-/api/v1 scopes (the LLM gateway surfaces) render failures in
 *  their own wire contracts; default is the /api/v1 envelope. */
export function installErrorHandling(
  app: FastifyInstance,
  renderApiError: (error: ApiError, path: string) => { status: number; body: string } = (error) => ({
    status: error.status,
    body: JSON.stringify({ error: { code: error.code, message: error.message } }),
  }),
): void {
  app.setErrorHandler((error: unknown, req, reply) => {
    if (error instanceof ApiError) {
      if (error.status === 500) req.log.error(error);
      const rendered = renderApiError(error, req.url ?? "");
      return reply.status(rendered.status).type("application/json").send(rendered.body);
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
    const rendered = renderApiError(new ApiError(500, "internal", "internal server error"), req.url ?? "");
    return reply.status(rendered.status).type("application/json").send(rendered.body);
  });
  // No custom not-found handler: unmatched methods/paths inside the native
  // route groups must keep falling through to the proxy catch-all (Rust 404
  // envelope), so per-area rollback stays "delete the TS route".
}
