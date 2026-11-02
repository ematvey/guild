// Signed-in servers and sign-in (desktop only — the browser is
// single-server), plus the account-level reads the shell needs.

import { HAS_ENGINE, clearToken, getToken, setToken } from "../session";
import { rpcCall } from "../machine-rpc";
import { ApiError, apiErrorFrom, request, requestResponse } from "./request";

// ---- Signed-in servers (desktop only — the browser is single-server) ----

/** One signed-in server: origin + its signed-in email + whether a usable
 * token survived the last restore (false = "sign in again"), plus the
 * server's display name and logo URL (server-relative). */
export type ServerRow = {
  base_url: string;
  email?: string | null;
  has_token: boolean;
  name?: string | null;
  logo_url?: string | null;
};
export type ServerList = {
  active: string | null;
  /** Wire field name from workspace.list; each entry is one server. */
  workspaces: ServerRow[];
};

/** Every signed-in server plus the active pointer (the switcher's data). */
export async function serverList(): Promise<ServerList | null> {
  if (!HAS_ENGINE) return null;
  const res = await rpcCall("workspace.list", {}, 20_000);
  if (res.error) throw new Error(res.error.message ?? "workspace.list failed");
  return res.result as ServerList;
}

/** Makes another signed-in server active. The caller mirrors the returned
 * session.info shape into localStorage and reloads. */
export async function serverSwitch(baseUrl: string): Promise<void> {
  const res = await rpcCall("workspace.switch", { base_url: baseUrl }, 30_000);
  if (res.error) throw new Error(res.error.message ?? "workspace.switch failed");
}

/** Signs one server out (active when omitted) — full engine sign-out, not
 * the webview-token-only default. */
export async function serverSignOut(baseUrl?: string): Promise<void> {
  const res = await rpcCall("session.clear", baseUrl ? { base_url: baseUrl } : {}, 30_000);
  if (res.error) throw new Error(res.error.message ?? "sign-out failed");
}

export async function apiLogin(
  url: string,
  email: string,
  password: string,
): Promise<{
  email: string;
  role: string;
  display_name?: string;
  avatar_url?: string;
  onboarded?: boolean;
}> {
  // Sign-in precedes the session: it names its server explicitly and
  // carries no bearer, so it is the one call that bypasses `request`.
  const res = await fetch(`${url.replace(/\/$/, "")}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw await apiErrorFrom(res);
  const v = await res.json().catch(() => ({}));
  setToken(v.token);
  return {
    email: v.user?.email ?? email,
    role: v.user?.role ?? "member",
    display_name: v.user?.display_name,
    avatar_url: v.user?.avatar_url,
    onboarded: v.user?.onboarded ?? true,
  };
}

export async function apiLogout(): Promise<void> {
  try {
    await requestResponse("POST", "/api/v1/auth/logout", { signal: AbortSignal.timeout(3000) });
  } catch {
    /* Revocation is best effort; local sign-out must finish. */
  }
}

export async function apiMe(): Promise<{
  email: string;
  role: string;
  display_name?: string;
  avatar_url?: string;
  onboarded?: boolean;
} | null> {
  if (!getToken()) return null;
  let v: {
    email: string;
    role?: string;
    display_name?: string | null;
    avatar_url?: string | null;
    onboarded?: boolean;
  };
  try {
    v = await request<typeof v>("GET", "/api/v1/auth/me");
  } catch (e) {
    // A session the refresh could not renew is over: drop the token.
    if (e instanceof ApiError && e.status === 401) {
      clearToken();
      return null;
    }
    throw e;
  }
  return {
    email: v.email,
    role: v.role ?? "member",
    display_name: v.display_name ?? undefined,
    avatar_url: v.avatar_url ?? undefined,
    onboarded: v.onboarded ?? true,
  };
}

/** Marks the first-run onboarding wizard as done (finished or skipped). */
export async function apiOnboarded(): Promise<void> {
  try {
    await requestResponse("PUT", "/api/v1/me/onboarded", { signal: AbortSignal.timeout(5000) });
  } catch {
    /* best effort — the wizard just re-shows on next login */
  }
}

/** A model route as chats see it: the id travels on the wire, the alias is
 *  the display name (empty when the admin has not named the route). */
