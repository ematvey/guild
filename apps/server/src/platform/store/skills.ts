// Per-user org-skill installs over the skill_installs table: one row per
// (user, slug); the pin is the version the user's agents run with, and
// updates advance it explicitly.

import { ApiError } from "../errors.js";
import { pgTimestampToRfc3339 } from "../time.js";
import { uuidv7 } from "../time.js";
import type { PlatformPool } from "../db.js";

export interface InstallRow {
  slug: string;
  pinned_version: string;
  installed_at: string;
}

const INSTALLED_AT_TEXT =
  "to_char(installed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS installed_at";

export class SkillStore {
  constructor(readonly pool: PlatformPool) {}

  /** Installs a skill for a user at the given pinned version; a repeated
   *  install of the same slug re-pins the existing row instead of
   *  duplicating it (UNIQUE (user_id, slug)). */
  async install(orgId: string, userId: string, slug: string, version: string): Promise<InstallRow> {
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
      "SELECT pinned_version, count(*)::text AS n FROM skill_installs " +
      "WHERE org_id = $1 AND slug = $2 GROUP BY pinned_version ORDER BY count(*) DESC, pinned_version",
      [orgId, slug],
    );
    return res.rows.map((r) => ({ version: r.pinned_version, count: Number(r.n) }));
  }

  private row(r: Record<string, unknown>): InstallRow {
    return {
      slug: r.slug as string,
      pinned_version: r.pinned_version as string,
      installed_at: pgTimestampToRfc3339(r.installed_at as string),
    };
  }
}
