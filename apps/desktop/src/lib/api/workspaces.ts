// Multi-workspace sessions and sign-in (desktop only — the browser is
// single-server), plus the account-level reads the shell needs.

import { IS_TAURI, apiUrl, clearToken, getToken, setToken } from "../session";
import { rpcCall } from "../machine-rpc";

// ---- Multi-workspace (desktop only — the browser is single-server) ----

/** One live session: server origin + its signed-in email + whether a
 * usable token survived the last restore (false = "sign in again"), plus
 * the workspace's display name and logo URL (server-relative). */
export type WorkspaceRow = {
  base_url: string;
  email?: string | null;
  has_token: boolean;
  name?: string | null;
  logo_url?: string | null;
};
export type WorkspaceList = {
  active: string | null;
  workspaces: WorkspaceRow[];
};

/** Every live session plus the active pointer (the switcher's data). */
export async function workspaceList(): Promise<WorkspaceList | null> {
  if (!IS_TAURI) return null;
  const res = await rpcCall("workspace.list", {}, 20_000);
  if (res.error) throw new Error(res.error.message ?? "workspace.list failed");
  return res.result as WorkspaceList;
}

/** Makes another live workspace active. The caller mirrors the returned
 * session.info shape into localStorage and reloads. */
export async function workspaceSwitch(baseUrl: string): Promise<void> {
  const res = await rpcCall("workspace.switch", { base_url: baseUrl }, 30_000);
  if (res.error) throw new Error(res.error.message ?? "workspace.switch failed");
}

/** Signs one workspace out (active when omitted) — full engine sign-out,
 * not the webview-token-only default. */
export async function workspaceSignOut(baseUrl?: string): Promise<void> {
  const res = await rpcCall(
    "session.clear",
    baseUrl ? { base_url: baseUrl } : {},
    30_000,
  );
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
  const res = await fetch(`${url.replace(/\/$/, "")}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const v = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(v?.error?.message ?? res.statusText);
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
    await fetch(apiUrl("/api/v1/auth/logout"), {
      method: "POST",
      headers: { authorization: `Bearer ${getToken()}` },
      signal: AbortSignal.timeout(3000),
    });
  } catch { /* Revocation is best effort; local sign-out must finish. */ }
}

export async function apiMe(): Promise<{
  email: string;
  role: string;
  display_name?: string;
  avatar_url?: string;
  onboarded?: boolean;
} | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetch(apiUrl("/api/v1/auth/me"), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (res.status === 401) {
    clearToken();
    return null;
  }
  const v = await res.json().catch(() => ({}));
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
    await fetch(apiUrl("/api/v1/me/onboarded"), {
      method: "PUT",
      headers: { authorization: `Bearer ${getToken()}` },
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* best effort — the wizard just re-shows on next login */ }
}

export type ChatViewMode = "casual" | "technical";

/** The signed-in user's chat view mode (user_kv server-side). Default and
 *  failure fallback: casual. */
export async function fetchChatViewMode(): Promise<ChatViewMode> {
  try {
    const res = await fetch(apiUrl("/api/v1/me/settings"), {
      headers: { authorization: `Bearer ${getToken()}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return "casual";
    const v = await res.json().catch(() => ({}));
    return v.chat_view === "technical" ? "technical" : "casual";
  } catch { return "casual"; }
}

export async function saveChatViewMode(mode: ChatViewMode): Promise<void> {
  try {
    await fetch(apiUrl("/api/v1/me/settings"), {
      method: "PUT",
      headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
      body: JSON.stringify({ chat_view: mode }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* best effort — the toggle already applied locally */ }
}

/** A model route as chats see it: the id travels on the wire, the alias is
 *  the display name (empty when the admin has not named the route). */

