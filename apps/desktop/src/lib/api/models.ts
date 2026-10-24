// Model catalog and the caller's API keys.

import { apiUrl, getToken } from "../session";

export interface ModelOption {
  id: string;
  alias: string;
}

export async function listModels(): Promise<ModelOption[] | null> {
  try {
    const token = getToken();
  // /api/v1/models is primary since the 2026-10-15 thread rename; the
  // server keeps /api/v1/gateway/models as a deprecated alias.
  const res = await fetch(apiUrl("/api/v1/models"), {
      headers: { authorization: `Bearer ${token}` },
    });
    // null = request failed (distinguishable from a legitimately empty list)
    if (!res.ok) return null;
    const v = await res.json().catch(() => ({}));
    const ids: unknown = v.models ?? [];
    const aliases: Record<string, string> = v.aliases ?? {};
    return Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === "string")
          .map((id) => ({ id, alias: aliases[id] ?? "" }))
      : [];
    } catch {
    // A rejected fetch (offline, TLS, server down) is a failure like any
    // other: the null contract covers it, so call sites only handle null.
    return null;
  }
}

/** The chat-visible label: the admin's alias, else the route id. */
export function modelLabel(m: ModelOption): string {
  return m.alias !== "" ? m.alias : m.id;
}


export interface ApiKeyInfo {
  id: string;
  name: string;
  /** Key prefix (`gk_XXXXXX…`) — the only non-secret fragment on file. */
  prefix: string;
  created_at: string;
  revoked_at?: string | null;
}

/** This user's gateway API keys (Settings → API Keys). */
export async function listMyApiKeys(): Promise<ApiKeyInfo[] | null> {
  const res = await fetch(apiUrl("/api/v1/api-keys"), {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) return null;
  const v = await res.json().catch(() => ({}));
  return v?.keys ?? [];
}

/** Mints a key; the plaintext is shown exactly once, in the response. */
export async function createMyApiKey(
  name: string,
): Promise<{ key: ApiKeyInfo; plaintext: string } | null> {
  const res = await fetch(apiUrl("/api/v1/api-keys"), {
    method: "POST",
    headers: { authorization: `Bearer ${getToken()}`, "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) return null;
  const v = await res.json().catch(() => ({}));
  if (!v?.plaintext || !v?.key) return null;
  return { key: v.key, plaintext: v.plaintext };
}

/** Revokes one of this user's keys. */
export async function revokeMyApiKey(id: string): Promise<boolean> {
  const res = await fetch(apiUrl(`/api/v1/api-keys/${encodeURIComponent(id)}`), {
    method: "DELETE",
    headers: { authorization: `Bearer ${getToken()}` },
  });
  return res.ok;
}

