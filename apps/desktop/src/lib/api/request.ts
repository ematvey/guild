// The one HTTP client for the Guild REST API. Every call carries the bearer
// token, resolves its path through apiUrl (same-origin on the web, the
// paired server inside the Tauri webview), and fails with one error type
// built from the server's `{error: {code, message}}` envelope.
//
// 401 policy: the session is refreshed once and the call retried; when the
// refresh is refused the call fails with code "unauthorized". Signing out
// is the member socket's job (it hears auth_required), never a request's.

import { apiUrl, getToken, guildSurfaceHeaders, refreshSession } from "../session";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** The error a failed response carries: the server's envelope when the body
 *  has one, else the HTTP status (a proxy answers with non-JSON and often an
 *  empty statusText, so the status code is the only fact left). */
export async function apiErrorFrom(res: Response): Promise<ApiError> {
  const text = await res.text().catch(() => "");
  let code = `http_${res.status}`;
  let message = res.statusText || `The server answered HTTP ${res.status}`;
  try {
    const envelope = JSON.parse(text) as { error?: { code?: unknown; message?: unknown } };
    if (typeof envelope.error?.code === "string") code = envelope.error.code;
    if (typeof envelope.error?.message === "string" && envelope.error.message !== "") message = envelope.error.message;
  } catch {
    // Non-JSON body: the status stands.
  }
  return new ApiError(code, message, res.status);
}

export interface RawInit {
  body?: BodyInit;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

/** Sends one request and returns the successful response; throws ApiError
 *  for any non-2xx answer. For bodies that are not JSON (uploads, blobs,
 *  streams). */
export async function requestResponse(method: string, path: string, init: RawInit = {}): Promise<Response> {
  const send = (): Promise<Response> => {
    const token = getToken();
    return fetch(apiUrl(path), {
      method,
      body: init.body,
      ...(init.signal !== undefined ? { signal: init.signal } : {}),
      headers: {
        ...init.headers,
        ...guildSurfaceHeaders(path),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
    });
  };
  let res = await send();
  if (res.status === 401 && getToken()) {
    try {
      await refreshSession();
    } catch {
      throw new ApiError("unauthorized", "Your session expired. Sign in again.", 401);
    }
    res = await send();
  }
  if (!res.ok) throw await apiErrorFrom(res);
  return res;
}

/** A JSON request: `body` is serialized when given; the answer is parsed as
 *  JSON (an empty answer resolves to undefined). `init` adds headers and an
 *  abort signal. */
export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  init: Omit<RawInit, "body"> = {},
): Promise<T> {
  const res = await requestResponse(
    method,
    path,
    body === undefined
      ? init
      : { ...init, body: JSON.stringify(body), headers: { ...init.headers, "content-type": "application/json" } },
  );
  const text = await res.text();
  return (text === "" ? undefined : JSON.parse(text)) as T;
}
