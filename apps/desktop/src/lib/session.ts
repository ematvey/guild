// Server address, token storage and session refresh. Two modes, same UI:
//  - Tauri (desktop): the paired server URL the shell stored; the token
//    lives in localStorage of the webview.
//  - Web (served by guild-server): same-origin, the same localStorage key.

export const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/// Base URL for server HTTP calls. Web: same-origin (guild-server serves the
/// app). Tauri: the webview origin is tauri://localhost, which the server
/// knows nothing about — same-origin fetches would die there — so they go to
/// the paired server URL the shell stored (afterAuth writes it from
/// session.info). Falls back to same-origin (""), e.g. pre-pairing.
export function serverBase(): string {
  if (IS_TAURI) {
    try {
      return (localStorage.getItem("guild.serverUrl") ?? "").replace(/\/$/, "");
    } catch {
      return "";
    }
  }
  return "";
}

/** Absolute URL for a server path ("/api/…"), base-aware. */
export function apiUrl(path: string): string {
  return `${serverBase()}${path}`;
}

/** The real server origin ("https://guild.example"). Web: the page origin.
 * Tauri: the paired server URL — the webview origin (tauri.localhost) is not
 * a routable address, so codes built from it would be unusable. */
export function serverUrl(): string {
  return serverBase() || window.location.origin;
}

export const TOKEN_KEY = "guild_token";

export function wsUrl(): string {
  const base = serverBase();
  if (base) {
    const url = new URL(base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString().replace(/\/$/, "");
  }
  if (typeof window === "undefined") return "";
  return `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}`;
}

// The refresh in flight and the account it was started for: a response
// is applied only while that same credential is still installed, so a
// response delivered after sign-out (or after another account signed in)
// is discarded instead of overwriting the newer bearer. The single-flight
// promise is scoped to the same credential — a refresh for a freshly
// signed-in account starts its own.
let refreshing: Promise<void> | null = null;
let refreshingFor: string | null = null;
export function refreshSession(): Promise<void> {
  const bearer = getToken();
  if (refreshing && refreshingFor === bearer) return refreshing;
  const pending = doRefresh(bearer).finally(() => {
    if (refreshingFor === bearer) {
      refreshing = null;
      refreshingFor = null;
    }
  });
  refreshingFor = bearer;
  refreshing = pending;
  return pending;
}

async function doRefresh(bearer: string | null): Promise<void> {
  const base = serverBase();
  const response = await fetch(`${base}/api/v1/auth/refresh`, {
    method: "POST", headers: { authorization: `Bearer ${bearer}` },
    signal: AbortSignal.timeout(10000),
  });
  if (response.status === 401 || response.status === 403) throw new SessionExpiredError("Sign in again to reconnect");
  if (!response.ok) throw new Error("Session refresh is temporarily unavailable");
  const value = await response.json();
  // The bearer (and the paired server) must still be the ones this refresh
  // was started with — otherwise the response is stale for this session.
  if (typeof value.token === "string" && getToken() === bearer && serverBase() === base) {
    setToken(value.token);
  }
}

/** Mints a one-use ticket for a WebSocket upgrade. */
export class SessionExpiredError extends Error {}
export async function mintTicket(refreshed = false): Promise<string> {
  const res = await fetch(apiUrl("/api/v1/ws/ticket"), {
    method: "POST",
    signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (res.status === 401 && !refreshed) {
    await refreshSession();
    return mintTicket(true);
  }
  if (res.status === 401) throw new SessionExpiredError("Sign in again to reconnect");
  const value = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(ticketFailure(res, value));
  if (typeof value.ticket !== "string") {
    throw new Error("The server sent no socket ticket");
  }
  return value.ticket;
}

/** An error the user can read: the API's own message, else the HTTP status.
 *  A proxy answers with a non-JSON body and an empty statusText, so the
 *  status code is the only fact left. */
function ticketFailure(res: Response, value: { error?: { message?: unknown } }): string {
  const detail = value.error?.message;
  if (typeof detail === "string" && detail.trim() !== "") return detail;
  return `The server answered HTTP ${res.status}`;
}

/** Opens a WebSocket through the injectable browser socket factory. */

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(t: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* ignore */
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

