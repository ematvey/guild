// Domain error types. `/api/v1` answers every failure in its envelope,
// {"error":{"code":"...","message":"..."}}. The LLM gateway surfaces render
// ApiError in their own wire contracts and reject malformed request bodies
// with plain-text TextError bodies (llm-gateway.ts builds those texts).
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

  /** The `/api/v1` envelope body. */
  envelope(): { error: { code: string; message: string } } {
    return { error: { code: this.code, message: this.message } };
  }

  static badRequest(message: string): ApiError {
    return new ApiError(400, "bad_request", message);
  }

  static unauthorized(message: string): ApiError {
    return new ApiError(401, "unauthorized", message);
  }

  static unsupportedMediaType(message: string): ApiError {
    return new ApiError(415, "unsupported_media_type", message);
  }

  static forbidden(message: string): ApiError {
    return new ApiError(403, "forbidden", message);
  }

  /** The admin gate's refusal. */
  static adminRequired(): ApiError {
    return ApiError.forbidden("admin role required");
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

/** Plain-text rejection (the LLM gateway surfaces' body-parse failures). */
export class TextError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(body);
  }
}
