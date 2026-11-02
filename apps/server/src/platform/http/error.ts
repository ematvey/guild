// Transport-level request helpers over the domain error types: the Fastify
// extractions (auth user, admin user, JSON and binary bodies, query/path
// params), the JSON content parser, the JSON reply, and the error handler
// installation. The wire shapes themselves (ApiError, TextError) live in
// platform/errors.ts — stores and services import from there, never from
// this module.

import { AdmissionCancelled } from "../../harness/operations.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isUuid } from "../time.js";
import { ApiError, TextError } from "../errors.js";
import type { UserRow } from "../store/identity.js";
import type { IdentityCtx } from "../route-contexts.js";

/** Where the JSON content parser keeps the request's raw body text. */
const RAW_BODY = Symbol("rawBody");

/** The raw text of a JSON request body ("" when the body was not JSON). */
export function rawJsonText(req: FastifyRequest): string {
  return (req as unknown as Record<symbol, string | undefined>)[RAW_BODY] ?? "";
}

/** A content parser for `application/json` that keeps the raw text (see
 *  rawJsonText) and turns a parse failure into `onError(detail)`. */
export function jsonContentParser(
  onError: (detail: string) => Error,
): (req: FastifyRequest, body: string | Buffer, done: (err: Error | null, body?: unknown) => void) => void {
  return (req, body, done) => {
    const text = typeof body === "string" ? body : body.toString("utf8");
    (req as unknown as Record<symbol, string>)[RAW_BODY] = text;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      done(onError(error instanceof Error ? error.message : String(error)), undefined);
      return;
    }
    done(null, parsed);
  };
}

/** A path parameter that must be a UUID, lowercased. */
export function parseUuidParam(req: FastifyRequest, param: string): string {
  const value = pathParam(req, param);
  if (!isUuid(value)) throw ApiError.badRequest(`${param} must be a UUID`);
  return value.toLowerCase();
}

/** A path parameter as given ("" when absent). */
export function pathParam(req: FastifyRequest, name: string): string {
  return (req.params as Record<string, string | undefined>)[name] ?? "";
}

/** The authenticated user from the session table. */
export async function requireUser(ctx: IdentityCtx, req: FastifyRequest): Promise<UserRow> {
  const header = req.headers.authorization;
  if (header === undefined) {
    throw ApiError.unauthorized("missing authorization header");
  }
  if (!header.startsWith("Bearer ")) {
    throw ApiError.unauthorized("expected Bearer token");
  }
  return ctx.identity.validateSession(header.slice("Bearer ".length));
}

/** The authenticated user, who must be an org admin (403 otherwise). */
export async function requireAdminUser(ctx: IdentityCtx, req: FastifyRequest): Promise<UserRow> {
  const user = await requireUser(ctx, req);
  if (user.role !== "admin") throw ApiError.adminRequired();
  return user;
}

/** A JSON object body: the request must say `Content-Type:
 *  application/json` (415 otherwise) and carry an object (400 otherwise). */
export function requireJsonBody(req: FastifyRequest): Record<string, unknown> {
  const contentType = req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw ApiError.unsupportedMediaType("expected Content-Type: application/json");
  }
  const body = req.body;
  if (body === undefined || body === null || typeof body !== "object" || Array.isArray(body)) {
    throw ApiError.badRequest("request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

/** The body of a route whose JSON body is optional: the parsed object, or
 *  an empty one when there is no object body. */
export function optionalJsonBody(req: FastifyRequest): Record<string, unknown> {
  const body = req.body;
  return body !== null && typeof body === "object" && !Array.isArray(body) && !Buffer.isBuffer(body)
    ? (body as Record<string, unknown>)
    : {};
}

/** Required string fields of a JSON body (400 when one is absent or not a
 *  string). */
export function requireStringFields(
  body: Record<string, unknown>,
  fields: [string, ...string[]],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = body[field];
    if (value === undefined) throw ApiError.badRequest(`${field} is required`);
    if (typeof value !== "string") throw ApiError.badRequest(`${field} must be a string`);
    out[field] = value;
  }
  return out;
}

/** The request body as bytes (binary uploads; empty when absent). */
export function bodyBytes(req: FastifyRequest): Buffer {
  const body = req.body;
  if (Buffer.isBuffer(body)) return body;
  if (typeof body === "string") return Buffer.from(body);
  return Buffer.alloc(0);
}

/** One query parameter (the first occurrence), undefined when absent. */
export function queryParam(req: { url: string }, name: string): string | undefined {
  const url = new URL(req.url, "http://local");
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}

/** Sends `value` as a JSON body. */
export function sendJson(reply: FastifyReply, value: unknown): FastifyReply {
  return reply.type("application/json").send(JSON.stringify(value));
}

/** Installs the error handling on the encapsulated scope. `renderApiError`
 *  lets non-/api/v1 scopes (the LLM gateway surfaces) render failures in
 *  their own wire contracts; default is the /api/v1 envelope. */
export function installErrorHandling(
  app: FastifyInstance,
  renderApiError: (error: ApiError, path: string) => { status: number; body: string } = (error) => ({
    status: error.status,
    body: JSON.stringify(error.envelope()),
  }),
): void {
  app.setErrorHandler((error: unknown, req, reply) => {
    const send = (apiError: ApiError) => {
      const rendered = renderApiError(apiError, req.url ?? "");
      return reply.status(rendered.status).type("application/json").send(rendered.body);
    };
    if (error instanceof ApiError) {
      if (error.status === 500) req.log.error(error);
      return send(error);
    }
    if (error instanceof AdmissionCancelled) {
      return send(ApiError.conflict("cancelled", error.message));
    }
    if (error instanceof TextError) {
      return reply.status(error.status).type("text/plain; charset=utf-8").send(error.body);
    }
    const code = (error as { code?: string }).code;
    // Fastify's own request rejections (unsupported media type, body too
    // large, malformed body) keep their status.
    if (typeof code === "string" && code.startsWith("FST_ERR_CTP_")) {
      const status = (error as { statusCode?: number }).statusCode ?? 400;
      return send(new ApiError(status, status === 413 ? "payload_too_large" : "bad_request", (error as Error).message));
    }
    req.log.error(error);
    return send(ApiError.internal());
  });
}
