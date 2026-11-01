// Per-user org-skill installs over the skill_installs table: one row per
// (user, slug). The pin is optional — NULL means "follow the latest
// published version", which is what an install records unless the user
// pins a version explicitly.

import { ApiError } from "../errors.js";
import { pgTimestampToRfc3339 } from "../time.js";
import { uuidv7 } from "../time.js";
import type { PlatformPool } from "../db.js";
import type { SkillCatalogItem, SkillOwner } from "@guild/wire/rest";

export interface InstallRow {
  slug: string;
  /** The version the user pinned, or null to follow the latest. */
  pinned_version: string | null;
  installed_at: string;
}

/** A catalog row's owner, the same entry `ownerEntry` resolves: the owner
 *  user in the org, else the owner team, else none. */
function catalogOwner(r: Record<string, unknown>): SkillOwner | null {
  if (r.owner_user_id !== null) {
    return typeof r.owner_label === "string"
      ? {
          kind: "user",
          id: r.owner_user_id as string,
          label: r.owner_label,
          avatar_url: (r.owner_avatar_url as string | null) ?? null,
        }
      : null;
  }
  if (r.owner_team_id !== null && typeof r.team_label === "string") {
    return { kind: "team", id: r.owner_team_id as string, label: r.team_label, avatar_url: null };
  }
  return null;
}

const INSTALLED_AT_TEXT =
  "to_char(installed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS installed_at";

export class SkillStore {
  constructor(readonly pool: PlatformPool) {}

  /** Installs a skill for a user, pinned at `version` or unpinned (null,
   *  follow the latest); a repeated install of the same slug re-pins the
   *  existing row instead of duplicating it (UNIQUE (user_id, slug)). */
  async install(orgId: string, userId: string, slug: string, version: string | null): Promise<InstallRow> {
    const res = await this.pool.query(
      `INSERT INTO skill_installs (id, org_id, user_id, slug, pinned_version)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, slug) DO UPDATE SET pinned_version = EXCLUDED.pinned_version
       RETURNING slug, pinned_version, ${INSTALLED_AT_TEXT}`,
      [uuidv7(), orgId, userId, slug, version],
    );
    return this.row(res.rows[0]);
  }

  /** Removes the install row; 404 when the user does not have the slug. */
  async uninstall(orgId: string, userId: string, slug: string): Promise<void> {
    const res = await this.pool.query(
      "DELETE FROM skill_installs WHERE org_id = $1 AND user_id = $2 AND slug = $3",
      [orgId, userId, slug],
    );
    if (res.rowCount === 0) throw ApiError.notFound("skill is not installed");
  }

  /** Moves an existing install's pin to a version; 404 when the user does
   *  not have the slug (use install to pin on install). */
  async setPin(orgId: string, userId: string, slug: string, version: string): Promise<InstallRow> {
    const res = await this.pool.query(
      `UPDATE skill_installs SET pinned_version = $4
       WHERE org_id = $1 AND user_id = $2 AND slug = $3
       RETURNING slug, pinned_version, ${INSTALLED_AT_TEXT}`,
      [orgId, userId, slug, version],
    );
    if (res.rows[0] === undefined) throw ApiError.notFound("skill is not installed");
    return this.row(res.rows[0]);
  }

  async listForUser(orgId: string, userId: string): Promise<InstallRow[]> {
    const res = await this.pool.query(
      `SELECT slug, pinned_version, ${INSTALLED_AT_TEXT} FROM skill_installs
       WHERE org_id = $1 AND user_id = $2 ORDER BY slug`,
      [orgId, userId],
    );
    return res.rows.map((r: Record<string, unknown>) => this.row(r));
  }

  async byUserAndSlug(orgId: string, userId: string, slug: string): Promise<InstallRow | null> {
    const res = await this.pool.query(
      `SELECT slug, pinned_version, ${INSTALLED_AT_TEXT} FROM skill_installs
       WHERE org_id = $1 AND user_id = $2 AND slug = $3`,
      [orgId, userId, slug],
    );
    return res.rows[0] === undefined ? null : this.row(res.rows[0]);
  }

  /** How many users in the org have the slug installed. */
  async installCount(orgId: string, slug: string): Promise<number> {
    const res = await this.pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM skill_installs WHERE org_id = $1 AND slug = $2",
      [orgId, slug],
    );
    return Number(res.rows[0]?.n ?? "0");
  }

  /** Per-version pin distribution for the detail page, most-installed
   *  version first. */
  async pinCounts(orgId: string, slug: string): Promise<Array<{ version: string; count: number }>> {
    const res = await this.pool.query<{ pinned_version: string; n: string }>(
      "SELECT COALESCE(pinned_version, 'latest') AS pinned_version, count(*)::text AS n FROM skill_installs " +
      "WHERE org_id = $1 AND slug = $2 GROUP BY 1 ORDER BY count(*) DESC, 1",
      [orgId, slug],
    );
    return res.rows.map((r) => ({ version: r.pinned_version, count: Number(r.n) }));
  }

  /** The catalog/search row the Skills panel renders: live skill items with
   *  owner label, install totals, and how many pins sit on the latest
   *  version; q filters over description and the latest version's SKILL.md
   *  text. Tombstoned items never appear (provenance lives on the detail
   *  page only). */
  async catalog(orgId: string, q: string | null, limit = 200): Promise<SkillCatalogItem[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT i.slug, i.description, i.latest_version, i.owner_user_id, i.owner_team_id, i.maintainer_gated,
              COALESCE(NULLIF(u.display_name, ''), u.email) AS owner_label, u.avatar_url AS owner_avatar_url,
              t.name AS team_label,
              (SELECT count(*)::text FROM skill_installs si
               WHERE si.org_id = i.org_id AND si.slug = i.slug) AS installs,
              (SELECT count(*)::text FROM skill_installs si
               WHERE si.org_id = i.org_id AND si.slug = i.slug
                 AND (si.pinned_version = i.latest_version OR si.pinned_version IS NULL)) AS installs_latest
       FROM registry_items i
       LEFT JOIN users u ON u.id = i.owner_user_id AND u.org_id = i.org_id
       LEFT JOIN teams t ON t.id = i.owner_team_id AND t.org_id = i.org_id
       LEFT JOIN registry_versions v ON v.item_id = i.id AND v.version = i.latest_version
       WHERE i.org_id = $1 AND i.kind = 'skill' AND i.tombstoned_at IS NULL
         AND ($2::text IS NULL OR i.description ILIKE '%' || $2 || '%' OR v.skill_md_text ILIKE '%' || $2 || '%')
       ORDER BY i.slug
       LIMIT $3`,
      [orgId, q, Math.min(Math.max(limit, 1), 500)],
    );
    return res.rows.map((r) => ({
      slug: r.slug as string,
      description: r.description as string,
      latest_version: (r.latest_version as string | null) ?? null,
      owner: catalogOwner(r),
      maintainer_gated: r.maintainer_gated === true,
      installs: Number(r.installs ?? "0"),
      installs_latest: Number(r.installs_latest ?? "0"),
      tombstoned: false,
    }));
  }

  /** The owner display entry for detail/catalog rows: a user (label =
   *  display name or email) or a team (label = team name). */
  async ownerEntry(
    orgId: string,
    ownerUserId: string | null,
    ownerTeamId: string | null,
  ): Promise<{
    kind: "user" | "team";
    id: string;
    label: string;
    avatar_url: string | null;
  } | null> {
    if (ownerUserId !== null) {
      const res = await this.pool.query<{ label: string; avatar_url: string | null }>(
        "SELECT COALESCE(NULLIF(display_name, ''), email) AS label, avatar_url FROM users WHERE org_id = $1 AND id = $2",
        [orgId, ownerUserId],
      );
      const row = res.rows[0];
      return row === undefined
        ? null
        : { kind: "user", id: ownerUserId, label: row.label, avatar_url: row.avatar_url };
    }
    if (ownerTeamId !== null) {
      const res = await this.pool.query<{ label: string }>(
        "SELECT name AS label FROM teams WHERE org_id = $1 AND id = $2",
        [orgId, ownerTeamId],
      );
      const label = res.rows[0]?.label;
      return label === undefined
        ? null
        : { kind: "team", id: ownerTeamId, label, avatar_url: null };
    }
    return null;
  }

  private row(r: Record<string, unknown>): InstallRow {
    return {
      slug: r.slug as string,
      pinned_version: (r.pinned_version as string | null) ?? null,
      installed_at: pgTimestampToRfc3339(r.installed_at as string),
    };
  }
}
