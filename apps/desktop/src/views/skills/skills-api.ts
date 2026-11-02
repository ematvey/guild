// Skills API for the Skills panel: the detail payload (GET
// /api/v1/skills/:slug), the source, the activity feed and the action
// endpoints (install/uninstall/pin/gate/unpublish/fork/save). The catalog
// and the caller's installs are pushed on the member socket
// (views/skills/skills-store.ts). Every call follows lib/api/request's
// contract: it resolves with the server's value or throws an ApiError
// carrying the server's message; each view decides what a failure shows.

import type { SkillCatalogItem, SkillInstall, SkillOwner } from "@guild/wire/rest";
import { request } from "../../lib/api/request";

export type { SkillOwner };

/** One catalog entry (GET /api/v1/skills and the `skill_catalog` frame). */
export type SkillItem = SkillCatalogItem;

/** One published version row (GET /api/v1/skills/:slug). */
export interface SkillVersion {
  version: string;
  published_at: string;
  publisher: string | null;
  bundle_sha256: string | null;
}

export type { SkillInstall };

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

/** GET /api/v1/skills/activity?filter=… — the feed's first page. */
export async function skillsActivity(filter: SkillActivityFilter = "all"): Promise<SkillActivityEvent[]> {
  const body = await request<{ events: SkillActivityEvent[] }>("GET", `/api/v1/skills/activity?filter=${filter}`);
  return body.events;
}

/** GET /api/v1/skills/installs — the signed-in user's org installs (one
 *  row per installed skill, with its pinned version). The turn's context
 *  assembly reads it outside the socket's reach. */
export async function fetchInstalls(): Promise<SkillInstall[]> {
  return (await request<{ installs: SkillInstall[] }>("GET", "/api/v1/skills/installs")).installs;
}

/** What an action answers: the saved slug and the caller's install, when
 *  the endpoint returns them. */
export interface SkillActionReply {
  slug?: string;
  install?: SkillInstall;
}

/** GET /api/v1/skills/:slug; an ApiError with status 404 when the skill
 *  does not exist. */
export async function skillsDetail(slug: string): Promise<SkillDetail> {
  return request<SkillDetail>("GET", slugPath(slug));
}

/** Runs one action; a refusal throws the server's ApiError. */
async function send(method: string, path: string, body?: unknown): Promise<SkillActionReply> {
  const v = (await request<{ slug?: unknown; install?: SkillInstall } | undefined>(method, path, body)) ?? {};
  return {
    ...(typeof v.slug === "string" ? { slug: v.slug } : {}),
    ...(v.install !== undefined ? { install: v.install } : {}),
  };
}

function slugPath(slug: string, suffix = ""): string {
  return `/api/v1/skills/${encodeURIComponent(slug)}${suffix}`;
}

export function skillsInstall(slug: string, version?: string): Promise<SkillActionReply> {
  return send("POST", slugPath(slug, "/install"), version === undefined ? {} : { version });
}

export function skillsUninstall(slug: string): Promise<SkillActionReply> {
  return send("DELETE", slugPath(slug, "/install"));
}

export function skillsPin(slug: string, version: string): Promise<SkillActionReply> {
  return send("POST", slugPath(slug, "/pin"), { version });
}

export function skillsGate(slug: string, enabled: boolean): Promise<SkillActionReply> {
  return send("POST", slugPath(slug, "/gate"), { enabled });
}

export function skillsUnpublish(slug: string): Promise<SkillActionReply> {
  return send("POST", slugPath(slug, "/unpublish"));
}

/** One team in the editor's owner selector. */
export interface EditorTeam {
  id: string;
  name: string;
}

/** The caller's team memberships (GET /api/v1/skills/teams) — one option
 *  per membership in the owner selector. */
export async function myTeams(): Promise<EditorTeam[]> {
  return (await request<{ teams: EditorTeam[] }>("GET", "/api/v1/skills/teams")).teams;
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
): Promise<{ version: string; skill_md: string; files: SkillSourceFile[] }> {
  const suffix = version === undefined ? "" : `?version=${encodeURIComponent(version)}`;
  return request<{ version: string; skill_md: string; files: SkillSourceFile[] }>(
    "GET",
    slugPath(slug, `/source${suffix}`),
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
export function skillsSave(req: SkillSaveRequest): Promise<SkillActionReply> {
  return send(req.method, req.path, req.body);
}

/** Fork (POST /api/v1/skills): seed a new slug from the source skill at
 *  `from_version`; the server copies the source bundle and records the
 *  provenance. */
export function skillsFork(payload: {
  slug: string;
  forked_from: string;
  from_version?: string;
}): Promise<SkillActionReply> {
  return send("POST", "/api/v1/skills", payload);
}
