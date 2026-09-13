// Thin API wrapper: bearer token in localStorage, single error envelope.
// Paths resolve through apiUrl: same-origin on the web, the paired server
// URL inside the Tauri webview (whose origin is tauri://localhost).

import { apiUrl } from "../../transport";

const TOKEN_KEY = "guild_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(t: string) {
  localStorage.setItem(TOKEN_KEY, t);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const token = getToken();
  const res = await fetch(apiUrl(path), {
    method,
    headers: {
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) {
    clearToken();
    throw new ApiError("unauthorized", "session expired — sign in again");
  }
  if (!res.ok) {
    const v = await res.json().catch(() => ({}));
    throw new ApiError(v?.error?.code ?? "unknown", v?.error?.message ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return text ? JSON.parse(text) : (undefined as T);
}

export interface UserInfo {
  id: string;
  email: string;
  org_id: string;
  role: string;
  display_name?: string;
  avatar_url?: string;
}

export async function me(): Promise<UserInfo> {
  return api<UserInfo>("GET", "/api/v1/auth/me");
}

export async function login(email: string, password: string): Promise<UserInfo> {
  const r = await api<{ token: string; user: UserInfo }>("POST", "/api/v1/auth/login", { email, password });
  setToken(r.token);
  return r.user;
}


export interface PairingToken {
  id: string;
  secret: string;
  expires_at: string;
}

/// Issues a one-time desktop-enrollment code; the client composes the full
/// code as `g1|<server_url>|<secret>` (the URL is routing info).
export async function createPairingToken(ttlMinutes = 30): Promise<PairingToken> {
  return api<PairingToken>("POST", "/api/v1/auth/pairing-tokens", { ttl_minutes: ttlMinutes });
}
