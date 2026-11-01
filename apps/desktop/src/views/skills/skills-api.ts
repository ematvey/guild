// Skills API for the Skills panel: the catalog (GET /api/v1/skills), the
// detail payload (GET /api/v1/skills/:slug), and the action endpoints
// (install/uninstall/pin/gate/unpublish/fork). Reads resolve to null on
// failure (the views show their empty state); actions never throw — they
// return an ok/message result the panel surfaces as a toast. Transport and
// error envelope come from lib/api/request.

import { ApiError, request } from "../../lib/api/request";

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
  return orNull(
    request<{ events: SkillActivityEvent[] }>("GET", `/api/v1/skills/activity?filter=${filter}`),
  ).then((v) => v?.events ?? null);
}

/** A read's value, or null when it failed. */
function orNull<T>(pending: Promise<T>): Promise<T | null> {
  return pending.catch(() => null);
}

/** GET /api/v1/skills/installs — the signed-in user's org installs (one
 *  row per installed skill, with its pinned version). Null on any failure
 *  (the local tab shows no org-installs list). */
export async function fetchInstalls(): Promise<SkillInstall[] | null> {
  return orNull(request<{ installs: SkillInstall[] }>("GET", "/api/v1/skills/installs")).then(
    (v) => v?.installs ?? null,
  );
}

export type SkillActionResult =
  | { ok: true; slug?: string; install?: SkillInstall }
  | { ok: false; message: string };

/** The org skill catalog; null on any failure (the panel shows its empty
 *  state). `q` narrows server-side; the panel filters client-side too. */
export async function skillsList(q?: string): Promise<SkillItem[] | null> {
  const path = q === undefined ? "/api/v1/skills" : `/api/v1/skills?q=${encodeURIComponent(q)}`;
  return orNull(request<{ items: SkillItem[] }>("GET", path)).then((v) => v?.items ?? null);
}

/** GET /api/v1/skills/:slug; null when the skill does not exist (or the
 *  request fails — the detail page shows its not-found state). */
export async function skillsDetail(slug: string): Promise<SkillDetail | null> {
  return orNull(request<SkillDetail>("GET", slugPath(slug)));
}

/** Runs one action; a failure carries the server's message. */
async function send(method: string, path: string, body?: unknown): Promise<SkillActionResult> {
  try {
    const v = (await request<{ slug?: unknown; install?: SkillInstall } | undefined>(method, path, body)) ?? {};
    return {
      ok: true,
      slug: typeof v.slug === "string" ? v.slug : undefined,
      install: v.install ?? undefined,
    };
  } catch (error) {
    return { ok: false, message: error instanceof ApiError || error instanceof Error ? error.message : String(error) };
  }
}

function slugPath(slug: string, suffix = ""): string {
  return `/api/v1/skills/${encodeURIComponent(slug)}${suffix}`;
}

export function skillsInstall(slug: string, version?: string): Promise<SkillActionResult> {
  return send("POST", slugPath(slug, "/install"), version === undefined ? {} : { version });
}

export function skillsUninstall(slug: string): Promise<SkillActionResult> {
  return send("DELETE", slugPath(slug, "/install"));
}

export function skillsPin(slug: string, version: string): Promise<SkillActionResult> {
  return send("POST", slugPath(slug, "/pin"), { version });
}

export function skillsGate(slug: string, enabled: boolean): Promise<SkillActionResult> {
  return send("POST", slugPath(slug, "/gate"), { enabled });
}

export function skillsUnpublish(slug: string): Promise<SkillActionResult> {
  return send("POST", slugPath(slug, "/unpublish"));
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
  const v = await orNull(request<{ teams: EditorTeam[] }>("GET", "/api/v1/skills/teams"));
  return v === null ? null : v.teams;
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
  return orNull(
    request<{ version: string; skill_md: string; files: SkillSourceFile[] }>(
      "GET",
      slugPath(slug, `/source${suffix}`),
    ),
  );
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
  return send(req.method, req.path, req.body);
}

/** Fork (POST /api/v1/skills): seed a new slug from the source skill at
 *  `from_version`; the server copies the source bundle and records the
 *  provenance. */
export function skillsFork(payload: {
  slug: string;
  forked_from: string;
  from_version?: string;
}): Promise<SkillActionResult> {
  return send("POST", "/api/v1/skills", payload);
}
