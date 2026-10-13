// Skills API for the Skills panel: the catalog (GET /api/v1/skills), the
// detail payload (GET /api/v1/skills/:slug), and the action endpoints
// (install/uninstall/pin/gate/unpublish/fork). Actions never throw — they
// return an ok/message result the panel surfaces as a toast.

import { apiUrl, getToken } from "../../transport";

export interface SkillOwner {
  kind: "user" | "team";
  id: string;
  label: string;
}

/** One catalog entry (GET /api/v1/skills). */
export interface SkillItem {
  slug: string;
  description: string;
  latest_version: string;
  owner: SkillOwner | null;
  maintainer_gated: boolean;
  installs: number;
  installs_latest?: number;
}

/** One published version row (GET /api/v1/skills/:slug). */
export interface SkillVersion {
  version: string;
  published_at: string;
  publisher: string | null;
  bundle_sha256: string | null;
}

/** The current user's install record, when installed. */
export interface SkillInstall {
  slug: string;
  pinned_version: string;
  installed_at: string;
}

export interface SkillPinCount {
  version: string;
  count: number;
}

/** GET /api/v1/skills/:slug — the detail page's payload. */
export interface SkillDetail {
  slug: string;
  description: string;
  latest_version: string | null;
  versions: SkillVersion[];
  forked_from: string | null;
  maintainer_gated: boolean;
  owner: SkillOwner | null;
  installs: number;
  pin_counts: SkillPinCount[];
  my_install: SkillInstall | null;
  tombstoned: boolean;
}

/** What the desktop knows about the signed-in user (drives owner-only UI). */
export interface SkillMe {
  role: string;
  displayName?: string;
  email?: string;
}

export type SkillActionResult =
  | { ok: true; slug?: string; install?: SkillInstall }
  | { ok: false; message: string };

/** The org skill catalog; null on any failure (the panel shows its empty
 *  state). `q` narrows server-side; the panel filters client-side too. */
export async function skillsList(q?: string): Promise<SkillItem[] | null> {
  const path = q === undefined ? "/api/v1/skills" : `/api/v1/skills?q=${encodeURIComponent(q)}`;
  const res = await fetch(apiUrl(path), {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) return null;
  const v = (await res.json().catch(() => null)) as { items?: SkillItem[] } | null;
  return v?.items ?? null;
}

/** GET /api/v1/skills/:slug; null when the skill does not exist (or the
 *  request fails — the detail page shows its not-found state). */
export async function skillsDetail(slug: string): Promise<SkillDetail | null> {
  const res = await fetch(apiUrl(`/api/v1/skills/${encodeURIComponent(slug)}`), {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as SkillDetail | null;
}

/** Fastify errors arrive as {error, message}; surface the message. */
async function send(path: string, init?: RequestInit): Promise<SkillActionResult> {
  try {
    const res = await fetch(apiUrl(path), {
      ...init,
      headers: { ...authHeaders(), ...init?.headers },
    });
    if (!res.ok) {
      const v = (await res.json().catch(() => null)) as { message?: string } | null;
      return { ok: false, message: v?.message ?? res.statusText };
    }
    const v = (await res.json().catch(() => ({}))) as {
      slug?: unknown;
      install?: unknown;
    };
    return {
      ok: true,
      slug: typeof v.slug === "string" ? v.slug : undefined,
      install: (v.install ?? undefined) as SkillInstall | undefined,
    };
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${getToken()}` };
}

function slugPath(slug: string, suffix = ""): string {
  return `/api/v1/skills/${encodeURIComponent(slug)}${suffix}`;
}

export function skillsInstall(slug: string, version?: string): Promise<SkillActionResult> {
  return send(slugPath(slug, "/install"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(version === undefined ? {} : { version }),
  });
}

export function skillsUninstall(slug: string): Promise<SkillActionResult> {
  return send(slugPath(slug, "/install"), { method: "DELETE" });
}

export function skillsPin(slug: string, version: string): Promise<SkillActionResult> {
  return send(slugPath(slug, "/pin"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version }),
  });
}

export function skillsGate(slug: string, enabled: boolean): Promise<SkillActionResult> {
  return send(slugPath(slug, "/gate"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}

export function skillsUnpublish(slug: string): Promise<SkillActionResult> {
  return send(slugPath(slug, "/unpublish"), { method: "POST" });
}

/** Fork (POST /api/v1/skills): seed a new slug from the source skill at
 *  `from_version`; the server copies the source bundle and records the
 *  provenance. */
export function skillsFork(payload: {
  slug: string;
  forked_from: string;
  from_version?: string;
}): Promise<SkillActionResult> {
  return send("/api/v1/skills", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}
