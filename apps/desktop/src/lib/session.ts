// Server address, token storage, session refresh, and which host this page
// runs in. Two modes, same UI:
//  - Tauri (desktop): the paired server URL the shell stored; the token
//    lives in localStorage of the webview.
//  - Web (served by guild-server): same-origin, the same localStorage key.
// The host question has a third answer below: a web page installed as an app
// (Home Screen or Dock), which is the only copy on iOS that can get Web Push.

export const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** localStorage keys owned by this module. */
export const SERVER_URL_KEY = "guild.serverUrl";
export const TOKEN_KEY = "guild_token";

/// Base URL for server HTTP calls. Web: same-origin (guild-server serves the
/// app). Tauri: the webview origin is tauri://localhost, which the server
/// knows nothing about — same-origin fetches would die there — so they go to
/// the paired server URL the shell stored (afterAuth writes it from
/// session.info). Falls back to same-origin (""), e.g. pre-pairing.
export function serverBase(): string {
  if (IS_TAURI) {
    try {
      return (localStorage.getItem(SERVER_URL_KEY) ?? "").replace(/\/$/, "");
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


// ---- which host is this page -------------------------------------------------
// The same question `IS_TAURI` answers, one level deeper: a web page can run
// as an installed app, and only the installed copy on iOS can receive Web
// Push. The surface is injected so the tests need no DOM.

export type InstallState =
  /** Running from the Home Screen or the Dock icon. */
  | "installed"
  /** iOS Safari, not installed: the Share-sheet steps apply. */
  | "ios-safari"
  /** iOS, another browser: it cannot install, and its copy gets no push. */
  | "ios-browser"
  /** Android Chrome: installable from the browser menu. */
  | "android"
  /** Desktop browser: no steps to show. */
  | "other";

export interface InstallSurface {
  userAgent: string;
  /** navigator.platform — iPadOS reports "MacIntel". */
  platform: string;
  maxTouchPoints: number;
  /** navigator.standalone, iOS only. */
  standalone: boolean;
  /** matchMedia("(display-mode: standalone)"), Android and desktop. */
  displayStandalone: boolean;
}

/** localStorage key: the login-card hint was dismissed. */
export const INSTALL_HINT_KEY = "guild.installHintDismissed";

const IOS_UA = /iPad|iPhone|iPod/;
/** Every other iOS browser wraps WebKit but cannot install a web app. */
const IOS_NOT_SAFARI = /CriOS|FxiOS|EdgiOS|OPiOS|DuckDuckGo/;

export function isIOS(s: InstallSurface): boolean {
  // iPadOS 13+ claims to be a Mac; the touch count gives it away.
  return IOS_UA.test(s.userAgent) || (s.platform === "MacIntel" && s.maxTouchPoints > 1);
}

export function installState(s: InstallSurface): InstallState {
  if (s.standalone || s.displayStandalone) return "installed";
  if (isIOS(s)) return IOS_NOT_SAFARI.test(s.userAgent) ? "ios-browser" : "ios-safari";
  if (/Android/.test(s.userAgent)) return "android";
  return "other";
}

/** sessionStorage key: the one reload that tries to repair the viewport. */
const VIEWPORT_REPAIR_KEY = "guild.viewportRepair";

/// An installed web app on iOS loses the status-bar inset from its viewport
/// after a Safari sheet closes: the page is still drawn from the top, but it
/// is 62pt shorter, and the strip below it cannot be laid out from CSS. A
/// document load gives the correct viewport back, so reload once per session
/// when the loss is seen. The band is bounded on both sides: a shorter page
/// for another reason (split view, external display) is left alone.
export function repairViewport(): void {
  try {
    const band = window.screen.height - window.innerHeight;
    if (!installSurface().standalone) return;
    if (band < 40 || band > 120) return;
    if (sessionStorage.getItem(VIEWPORT_REPAIR_KEY)) return;
    sessionStorage.setItem(VIEWPORT_REPAIR_KEY, "1");
    window.location.reload();
  } catch {
    /* storage blocked: leave the page alone */
  }
}

/** True when the page should offer the install steps. */
export function installOffered(s: InstallSurface): boolean {
  const state = installState(s);
  return state === "ios-safari" || state === "ios-browser" || state === "android";
}

/** Reads the live surface. Call on mount and after the user says they
 *  installed it: the media query and the navigator flag change only on a
 *  fresh launch, so a re-read is the honest check. */
export function installSurface(): InstallSurface {
  const standalone =
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  const displayStandalone =
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(display-mode: standalone)").matches
      : false;
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
    standalone,
    displayStandalone,
  };
}

export function installHintDismissed(): boolean {
  try {
    return localStorage.getItem(INSTALL_HINT_KEY) === "1";
  } catch {
    return false;
  }
}

export function dismissInstallHint(): void {
  try {
    localStorage.setItem(INSTALL_HINT_KEY, "1");
  } catch {
    /* private mode: the hint just shows again next launch */
  }
}
