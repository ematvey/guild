// Model catalog and the caller's API keys.

import { request } from "./request";

import type { ModelOption } from "@guild/wire/types";

export type { ModelOption };

/** The org's enabled models; null when the list cannot be read. */
export async function listModels(): Promise<ModelOption[] | null> {
  try {
    const v = await request<{ models?: unknown; aliases?: Record<string, string> }>("GET", "/api/v1/models");
    const aliases = v?.aliases ?? {};
    return Array.isArray(v?.models)
      ? v.models.filter((id): id is string => typeof id === "string").map((id) => ({ id, alias: aliases[id] ?? "" }))
      : [];
  } catch {
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

/** This user's gateway API keys (Settings → API Keys); null when they
 *  cannot be read. */
export async function listMyApiKeys(): Promise<ApiKeyInfo[] | null> {
  try {
    const v = await request<{ keys?: ApiKeyInfo[] }>("GET", "/api/v1/api-keys");
    return v?.keys ?? [];
  } catch {
    return null;
  }
}

/** Mints a key; the plaintext is shown exactly once, in the response.
 *  null when the server refuses. */
export async function createMyApiKey(name: string): Promise<{ key: ApiKeyInfo; plaintext: string } | null> {
  try {
    const v = await request<{ key?: ApiKeyInfo; plaintext?: string }>("POST", "/api/v1/api-keys", { name });
    return v?.plaintext && v?.key ? { key: v.key, plaintext: v.plaintext } : null;
  } catch {
    return null;
  }
}

/** Revokes one of this user's keys; false when the server refuses. */
export async function revokeMyApiKey(id: string): Promise<boolean> {
  try {
    await request<unknown>("DELETE", `/api/v1/api-keys/${encodeURIComponent(id)}`);
    return true;
  } catch {
    return false;
  }
}
