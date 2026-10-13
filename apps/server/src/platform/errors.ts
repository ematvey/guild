// Domain error types for `/api/v1`:
// {"error":{"code":"...","message":"..."}} — plus the extractor-rejection
// text bodies axum emits outside the envelope (JSON body parse/deserialize
// and path-param failures), which the Rust server leaks verbatim.
//
// This module is wire-shape only: no transport imports (Fastify, pools,
// stores). Transport-level helpers over these types live in
// platform/http/error.ts.

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
