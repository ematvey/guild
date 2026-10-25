// Skills API for the Skills panel: the catalog (GET /api/v1/skills), the
// detail payload (GET /api/v1/skills/:slug), and the action endpoints
// (install/uninstall/pin/gate/unpublish/fork). Actions never throw — they
// return an ok/message result the panel surfaces as a toast.

import { apiUrl, getToken } from "../../lib/session";

export interface SkillOwner {
  kind: "user" | "team";
  id: string;
  label: string;
  /** The owner user's avatar URL; null for teams and unset avatars. */
  avatar_url?: string | null;
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
/** Renders a registry version with exactly one "v" prefix. The server
 *  stores its own computed versions pre-prefixed ("v1") while
 *  user-published ones can be bare ("0.1.0") — naive `v${v}` templates
 *  render "vv1" for the former. */
export function displayVersion(version: string): string {
  return `v${version.replace(/^v/, "")}`;
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
  /** The pinned version, or null to follow the latest published version. */
  pinned_version: string | null;
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
  /** ClickHouse read analytics (spec §3): total reads (30d) plus a per-day
   *  series (14d). Absent on servers older than the read-stats fix. */
  read_stats?: { total: number; series: Array<{ day: string; reads: number }> } | null;
  tombstoned: boolean;
}

/** What the desktop knows about the signed-in user (drives owner-only UI). */
export interface SkillMe {
  role: string;
  displayName?: string;
  email?: string;
}

/** One activity-feed row (GET /api/v1/skills/activity): the raw org event.
 *  payload fields vary by kind — registry.published/updated carry only
 *  {kind, slug, version}; the other kinds add actor/forked_from. */
export interface SkillActivityEvent {
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
}

export type SkillActivityFilter = "all" | "changes";

/** GET /api/v1/skills/activity?filter=…; null on any failure (the feed
 *  shows its empty state). */
export async function skillsActivity(
  filter: SkillActivityFilter = "all",
): Promise<SkillActivityEvent[] | null> {
  const res = await fetch(apiUrl(`/api/v1/skills/activity?filter=${filter}`), {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) return null;
  const v = (await res.json().catch(() => null)) as { events?: SkillActivityEvent[] } | null;
  return v?.events ?? null;
}

/** GET /api/v1/skills/installs — the signed-in user's org installs (one
 *  row per installed skill, with its pinned version). Null on any failure
 *  (the local tab shows no org-installs list). */
export async function fetchInstalls(): Promise<SkillInstall[] | null> {
  const res = await fetch(apiUrl("/api/v1/skills/installs"), {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) return null;
  const v = (await res.json().catch(() => null)) as { installs?: SkillInstall[] } | null;
  return v?.installs ?? null;
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

/** One team in the editor's owner selector. */
export interface EditorTeam {
  id: string;
  name: string;
}

/** The caller's team memberships (GET /api/v1/skills/teams) — one option
 *  per membership in the owner selector. Null on any failure (the selector
 *  degrades to Me only). */
export async function myTeams(): Promise<EditorTeam[] | null> {
  const res = await fetch(apiUrl("/api/v1/skills/teams"), {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) return null;
  const v = (await res.json().catch(() => null)) as
    | { teams?: Array<{ id?: unknown; name?: unknown }> }
    | null;
  return (v?.teams ?? [])
    .filter((t) => typeof t.id === "string" && typeof t.name === "string")
    .map((t) => ({ id: t.id as string, name: t.name as string }));
}

/** One extra bundle file in a version's source manifest: path, size, sha and
 *  the file's text body (null for binary bodies or files over the inline cap). */
export interface SkillSourceFile {
  path: string;
  size: number;
  sha256: string;
  content: string | null;
}

/** GET /api/v1/skills/:slug/source — one version's SKILL.md body plus the
 *  bundle's extra files as path+sha+text; without an explicit
 *  version the server resolves the caller's pin, then latest. The editor's
 *  edit mode passes the latest version so the publish diff always runs
 *  against the newest published content. */
export async function skillsSource(
  slug: string,
  version?: string,
): Promise<{ version: string; skill_md: string; files: SkillSourceFile[] } | null> {
  const suffix = version === undefined ? "" : `?version=${encodeURIComponent(version)}`;
  const res = await fetch(apiUrl(slugPath(slug, `/source${suffix}`)), {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) return null;
  const v = (await res.json().catch(() => null)) as {
    version?: unknown;
    skill_md?: unknown;
    files?: unknown;
  } | null;
  if (v === null || typeof v.version !== "string" || typeof v.skill_md !== "string") return null;
  const files = Array.isArray(v.files)
    ? (v.files as Array<Partial<SkillSourceFile> & { path?: unknown }>)
        .filter((f) => f !== null && typeof f.path === "string")
        .map((f) => ({
          path: f.path as string,
          size: typeof f.size === "number" ? f.size : 0,
          sha256: typeof f.sha256 === "string" ? f.sha256 : "",
          content: typeof f.content === "string" ? f.content : null,
        }))
    : [];
  return { version: v.version, skill_md: v.skill_md, files };
}

/** POST /api/v1/skills body: a fresh skill at v1, optionally owned by a
 *  team (the server checks membership). */
export interface SkillCreatePayload {
  slug: string;
  description: string;
  body: string;
  owner_team_id?: string;
}

/** PUT /api/v1/skills/:slug body: publishes the next version; the slug
 *  and owner never change here. */
export interface SkillEditPayload {
  description: string;
  body: string;
}

/** The save request the editor builds for the current mode (pure —
 *  SkillEditor.saveRequest produces it, this executes it). */
export interface SkillSaveRequest {
  method: "POST" | "PUT";
  path: string;
  body: SkillCreatePayload | SkillEditPayload;
}

/** Executes the editor's save request against the skills API. */
export function skillsSave(req: SkillSaveRequest): Promise<SkillActionResult> {
  return send(req.path, {
    method: req.method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req.body),
  });
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
