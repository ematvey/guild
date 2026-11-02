// Registry records: org-scoped catalogs for skills, MCP servers, and
// integrations over the registry_items/registry_versions tables.

import { ApiError } from "../errors.js";
import { pgTimestampToRfc3339, utcText } from "../time.js";
import { uuidv7 } from "../time.js";
import { withTransaction, type PlatformPool } from "../db.js";
import { jsonbText } from "../domain/text.js";
import { canonicalJson } from "../domain/json.js";

const MAINTAINERS_ONLY = "only the item's maintainers can publish it";

export interface RegistryItemRow {
  slug: string;
  description: string;
  latest_version: string | null;
  review_status: string;
}

/** A skill search hit with its provenance: who published the latest
 *  version, when, who owns the item, and what it was forked from. Null
 *  when the registry has no version row (no publisher/date) or no owner. */
export interface SkillSearchRow extends RegistryItemRow {
  publisher: string | null;
  published_at: string | null;
  owner_kind: "user" | "team" | null;
  owner_label: string | null;
  forked_from: string | null;
}

export interface VersionRow {
  version: string;
  published_at: string;
  bundle_sha256: string | null;
  publisher: string | null;
}

export interface StoredVersion {
  manifest: unknown;
  object_key: string;
  bundle_sha256: string | null;
}

/** Struct-serialized shape (serde declaration order) for the wire. */
function itemRow(r: Record<string, unknown>): RegistryItemRow {
  return {
    slug: r.slug as string,
    description: r.description as string,
    latest_version: (r.latest_version as string | null) ?? null,
    review_status: r.review_status as string,
  };
}

/** The search row: the item fields plus its provenance. */
function searchRow(r: Record<string, unknown>): SkillSearchRow {
  const ownerUserId = (r.owner_user_id as string | null) ?? null;
  const ownerTeamId = (r.owner_team_id as string | null) ?? null;
  return {
    ...itemRow(r),
    publisher: (r.publisher as string | null) ?? null,
    published_at:
      r.published_at === null || r.published_at === undefined
        ? null
        : pgTimestampToRfc3339(r.published_at as string),
    owner_kind: ownerUserId !== null ? "user" : ownerTeamId !== null ? "team" : null,
    owner_label:
      (ownerUserId !== null
        ? (r.owner_user_label as string | null)
        : (r.owner_team_label as string | null)) ?? null,
    forked_from: (r.forked_from as string | null) ?? null,
  };
}

/** The provenance columns a search row carries, with the latest version's
 *  publisher label (display name or email) and publish time and the
 *  owner's display label (user name or team name). */
const SEARCH_COLUMNS =
  "i.slug, i.description, i.latest_version, i.review_status, i.forked_from, " +
  "i.owner_user_id, i.owner_team_id, " +
  "COALESCE(NULLIF(pu.display_name, ''), pu.email) AS publisher, " +
  utcText("v.published_at") + " AS published_at, " +
  "COALESCE(NULLIF(ou.display_name, ''), ou.email) AS owner_user_label, t.name AS owner_team_label";

/** Joins behind SEARCH_COLUMNS: the latest version row, its publisher, the
 *  owner user, the owner team. */
const SEARCH_JOINS =
  "LEFT JOIN registry_versions v ON v.item_id = i.id AND v.version = i.latest_version " +
  "LEFT JOIN users pu ON pu.id = v.published_by " +
  "LEFT JOIN users ou ON ou.id = i.owner_user_id " +
  "LEFT JOIN teams t ON t.id = i.owner_team_id";

/** The next append-only version for an item: the max numeric suffix across
 *  every existing vN row, + 1. Count-based arithmetic (`v${rows.length + 1}`)
 *  recomputes an existing version when a gap exists — legacy raw-route
 *  publishes v1 then v3 leave count 2, and "v3" would silently overwrite the
 *  live v3 through upsertVersion's same-latest short-circuit. Parsing the
 *  suffix keeps the (item_id, version) UNIQUE constraint meaningful: a
 *  computed version never collides. */
export function nextVersion(versions: Array<{ version: string }>): string {
  let max = 0;
  for (const v of versions) {
    const match = /^v(\d+)$/.exec(v.version);
    if (match !== null) max = Math.max(max, Number(match[1]));
  }
  return `v${max + 1}`;
}

export class RegistryStore {
  constructor(readonly pool: PlatformPool) {}

  /** Publishes (or republishes) a version. Any change to a version row's
   *  manifest OR bundle hash resets the item's review status to draft —
   *  the approval attaches to the exact reviewed manifest and bundle
   *  bytes. An unchanged re-upload keeps the status only while the standing
   *  approval is bound to content. Republishing an older version is
   *  refused: it would overwrite a superseded release. The item row is
   *  read and locked inside the transaction (no TOCTOU). Skill publishes
   *  carry the SKILL.md text + file projection; the first publish owns the
   *  item (owner_user_id = the publisher). */
  async upsertVersion(
    orgId: string,
    kind: string,
    slug: string,
    version: string,
    description: string,
    manifest: unknown,
    objectKey: string,
    bundleSha256: string,
    publisher: string,
    skill: { md_text: string; files: Array<{ path: string; size: number; sha256: string }> } | null = null,
    gate: { userId: string; role: string; isTeamMember: boolean } | null = null,
  ): Promise<void> {
    return withTransaction(this.pool, async (client) => {
      const itemRes = await client.query<{
        id: string;
        latest_version: string | null;
        review_status: string;
        reviewed_version: string | null;
        owner_user_id: string | null;
        owner_team_id: string | null;
        maintainer_gated: boolean;
        tombstoned_at: string | null;
      }>(
        "SELECT id, latest_version, review_status, reviewed_version, owner_user_id, owner_team_id, maintainer_gated, tombstoned_at " +
        "FROM registry_items WHERE org_id = $1 AND kind = $2 AND slug = $3 FOR UPDATE",
        [orgId, kind, slug],
      );
      let itemId: string;
      const item = itemRes.rows[0];
      // Publish gate re-checked under the row lock (spec §1.2): the
      // check-then-publish race is closed by deciding here, on the same
      // snapshot the version insert commits against.
      if (gate !== null && item !== undefined) {
        if (item.tombstoned_at !== null) throw ApiError.forbidden("this item was unpublished");
        if (item.maintainer_gated && gate.role !== "admin") {
          const owner = item.owner_user_id !== null && item.owner_user_id === gate.userId;
          if (!owner && !(item.owner_team_id !== null && gate.isTeamMember)) throw ApiError.forbidden(MAINTAINERS_ONLY);
        }
      }
      if (item !== undefined) {
        if (item.latest_version !== version) {
          const exists = await client.query(
            "SELECT 1::int8 FROM registry_versions WHERE item_id = $1 AND version = $2",
            [item.id, version],
          );
          if (exists.rows.length > 0) {
            throw ApiError.conflict(
              "version_superseded",
              "this version was already superseded by a newer release — publish a new version instead",
            );
          }
        }
        const prevRes = await client.query<{ manifest: unknown; bundle_sha256: string | null }>(
          "SELECT manifest, bundle_sha256 FROM registry_versions WHERE item_id = $1 AND version = $2",
          [item.id, version],
        );
        const prev = prevRes.rows[0];
        const unchanged =
          prev !== undefined &&
          canonicalJson(prev.manifest) === canonicalJson(manifest) &&
          prev.bundle_sha256 === bundleSha256;
        const approvalBound =
          item.reviewed_version !== null && item.reviewed_version === item.latest_version;
        const status =
          unchanged && item.latest_version === version && (item.review_status !== "approved" || approvalBound)
            ? item.review_status
            : "draft";
        await client.query(
          "UPDATE registry_items SET latest_version = $2, description = $3, review_status = $4, " +
          "reviewed_version = CASE WHEN $4 = 'approved' THEN latest_version ELSE NULL END, " +
          "reviewed_bundle_sha256 = CASE WHEN $4 = 'approved' THEN $5 ELSE NULL END " +
          "WHERE id = $1",
          [item.id, version, description, status, bundleSha256],
        );
        itemId = item.id;
      } else {
        itemId = uuidv7();
        await client.query(
          "INSERT INTO registry_items (id, org_id, kind, slug, description, latest_version, owner_user_id) " +
          "VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [itemId, orgId, kind, slug, description, version, publisher],
        );
      }
      await client.query(
        "INSERT INTO registry_versions (id, item_id, version, manifest, object_key, bundle_sha256, published_by, skill_md_text, files) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) " +
        "ON CONFLICT (item_id, version) " +
        "DO UPDATE SET manifest = EXCLUDED.manifest, object_key = EXCLUDED.object_key, " +
        "bundle_sha256 = EXCLUDED.bundle_sha256, published_by = EXCLUDED.published_by, " +
        "skill_md_text = EXCLUDED.skill_md_text, files = EXCLUDED.files, " +
        "published_at = now()",
        [
          uuidv7(),
          itemId,
          version,
          jsonbText(manifest),
          objectKey,
          bundleSha256,
          publisher,
          skill?.md_text ?? null,
          skill === null ? null : jsonbText(skill.files),
        ],
      );
    });
  }

  async listItems(orgId: string, kind: string): Promise<RegistryItemRow[]> {
    const res = await this.pool.query(
      "SELECT slug, description, latest_version, review_status FROM registry_items " +
      "WHERE org_id = $1 AND kind = $2 AND tombstoned_at IS NULL ORDER BY slug",
      [orgId, kind],
    );
    return res.rows.map(itemRow);
  }

  /** Skill search for the agent tool + prompt index (q matches the slug,
   *  description, or the latest version's SKILL.md text; tombstoned items
   *  never appear). An empty q lists the org's skills. Most-recently-
   *  updated first (the latest version's publish time), slug as the tie —
   *  the index's discovery surface leads with fresh work. */
  async searchSkills(orgId: string, q: string, limit = 12): Promise<SkillSearchRow[]> {
    const res = await this.pool.query(
      `SELECT ${SEARCH_COLUMNS} FROM registry_items i ${SEARCH_JOINS} ` +
      "WHERE i.org_id = $1 AND i.kind = 'skill' AND i.tombstoned_at IS NULL " +
      "AND (i.slug ILIKE '%' || $2 || '%' OR i.description ILIKE '%' || $2 || '%' OR v.skill_md_text ILIKE '%' || $2 || '%') " +
      "ORDER BY v.published_at DESC NULLS LAST, i.slug LIMIT $3",
      [orgId, q, Math.min(Math.max(limit, 1), 500)],
    );
    return res.rows.map(searchRow);
  }

  async itemVersions(orgId: string, kind: string, slug: string): Promise<VersionRow[]> {
    const res = await this.pool.query(
      "SELECT v.version, " + utcText("v.published_at") + " AS published_at, v.bundle_sha256, v.published_by AS publisher " +
      "FROM registry_versions v JOIN registry_items i ON i.id = v.item_id " +
      "WHERE i.org_id = $1 AND i.kind = $2 AND i.slug = $3 ORDER BY v.published_at DESC",
      [orgId, kind, slug],
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      version: r.version as string,
      published_at: pgTimestampToRfc3339(r.published_at as string),
      bundle_sha256: (r.bundle_sha256 as string | null) ?? null,
      publisher: (r.publisher as string | null) ?? null,
    }));
  }

  /** Tombstone state + gate/ownership info for one item (the detail page,
   *  the gate/unpublish permission checks, and the agent tools' provenance
   *  lines read this). `owner_label` is the owner's display label (user
   *  name or team name), null when the item has no owner. */
  async itemControl(orgId: string, kind: string, slug: string): Promise<{
    owner_user_id: string | null;
    owner_team_id: string | null;
    owner_label: string | null;
    maintainer_gated: boolean;
    tombstoned: boolean;
    latest_version: string | null;
    description: string;
    forked_from: string | null;
  } | null> {
    const res = await this.pool.query(
      "SELECT i.owner_user_id, i.owner_team_id, i.maintainer_gated, i.tombstoned_at, i.latest_version, i.description, i.forked_from, " +
      "COALESCE(COALESCE(NULLIF(ou.display_name, ''), ou.email), t.name) AS owner_label " +
      "FROM registry_items i LEFT JOIN users ou ON ou.id = i.owner_user_id " +
      "LEFT JOIN teams t ON t.id = i.owner_team_id " +
      "WHERE i.org_id = $1 AND i.kind = $2 AND i.slug = $3",
      [orgId, kind, slug],
    );
    const r = res.rows[0];
    if (r === undefined) return null;
    return {
      owner_user_id: (r.owner_user_id as string | null) ?? null,
      owner_team_id: (r.owner_team_id as string | null) ?? null,
      owner_label: (r.owner_label as string | null) ?? null,
      maintainer_gated: r.maintainer_gated === true,
      tombstoned: r.tombstoned_at !== null,
      latest_version: (r.latest_version as string | null) ?? null,
      description: r.description as string,
      forked_from: (r.forked_from as string | null) ?? null,
    };
  }

  /** Flips the maintainer gate; 404 when the item does not exist. */
  async setGate(orgId: string, kind: string, slug: string, enabled: boolean): Promise<void> {
    const res = await this.pool.query(
      "UPDATE registry_items SET maintainer_gated = $4 WHERE org_id = $1 AND kind = $2 AND slug = $3",
      [orgId, kind, slug, enabled],
    );
    if (res.rowCount === 0) throw ApiError.notFound("no such registry item");
  }

  /** Records fork provenance ("slug@version") on the item. */
  async setForkedFrom(orgId: string, kind: string, slug: string, forkedFrom: string): Promise<void> {
    await this.pool.query(
      "UPDATE registry_items SET forked_from = $4 WHERE org_id = $1 AND kind = $2 AND slug = $3",
      [orgId, kind, slug, forkedFrom],
    );
  }

  /** Hands item ownership to a team (the create route's owner pick). */
  async setOwnerTeam(orgId: string, kind: string, slug: string, teamId: string | null): Promise<void> {
    await this.pool.query(
      "UPDATE registry_items SET owner_team_id = $4, owner_user_id = NULL WHERE org_id = $1 AND kind = $2 AND slug = $3",
      [orgId, kind, slug, teamId],
    );
  }

  /** Full version metadata for the skill surface: the SKILL.md projection
   *  and file list live on the version row; `publisher_label` is the
   *  publisher's display label and `published_at` the publish time. Null
   *  when absent. */
  async getVersionMeta(
    orgId: string,
    kind: string,
    slug: string,
    version: string,
  ): Promise<{
    manifest: unknown;
    object_key: string;
    bundle_sha256: string | null;
    publisher: string | null;
    publisher_label: string | null;
    published_at: string | null;
    skill_md_text: string | null;
    files: Array<{ path: string; size: number; sha256: string }> | null;
  } | null> {
    const res = await this.pool.query(
      "SELECT v.manifest, v.object_key, v.bundle_sha256, v.published_by, v.skill_md_text, v.files, " +
      "COALESCE(NULLIF(u.display_name, ''), u.email) AS publisher_label, " +
      utcText("v.published_at") + " AS published_at " +
      "FROM registry_versions v JOIN registry_items i ON i.id = v.item_id " +
      "LEFT JOIN users u ON u.id = v.published_by " +
      "WHERE i.org_id = $1 AND i.kind = $2 AND i.slug = $3 AND v.version = $4",
      [orgId, kind, slug, version],
    );
    const r = res.rows[0];
    if (r === undefined) return null;
    return {
      manifest: r.manifest,
      object_key: r.object_key,
      bundle_sha256: (r.bundle_sha256 as string | null) ?? null,
      publisher: (r.published_by as string | null) ?? null,
      publisher_label: (r.publisher_label as string | null) ?? null,
      published_at:
        r.published_at === null || r.published_at === undefined
          ? null
          : pgTimestampToRfc3339(r.published_at as string),
      skill_md_text: (r.skill_md_text as string | null) ?? null,
      files: (r.files as Array<{ path: string; size: number; sha256: string }> | null) ?? null,
    };
  }

  /** Publish gate (spec §1.2): gated slugs accept pushes from the owner,
   *  the owner team's members, and admins only; tombstoned slugs reject
   *  everything (T3's editor-save path clears the tombstone before
   *  republishing). */
  async publishGate(orgId: string, kind: string, slug: string, userId: string, role: string, isTeamMember: boolean): Promise<void> {
    const item = await this.itemControl(orgId, kind, slug);
    if (item === null) return; // new slug — no gate
    if (item.tombstoned) throw ApiError.forbidden("this item was unpublished");
    if (!item.maintainer_gated || role === "admin") return;
    const owner = item.owner_user_id !== null && item.owner_user_id === userId;
    if (owner || (item.owner_team_id !== null && isTeamMember)) return;
    throw ApiError.forbidden(MAINTAINERS_ONLY);
  }

  /** Tombstones the item (unpublish): it leaves the catalog and refuses
   *  publishes until cleared. */
  async markUnpublished(orgId: string, kind: string, slug: string): Promise<void> {
    const res = await this.pool.query(
      "UPDATE registry_items SET tombstoned_at = now() WHERE org_id = $1 AND kind = $2 AND slug = $3 AND tombstoned_at IS NULL",
      [orgId, kind, slug],
    );
    if (res.rowCount === 0) throw ApiError.notFound("no such registry item");
  }

  async clearTombstone(orgId: string, kind: string, slug: string): Promise<void> {
    await this.pool.query(
      "UPDATE registry_items SET tombstoned_at = NULL WHERE org_id = $1 AND kind = $2 AND slug = $3",
      [orgId, kind, slug],
    );
  }

  async getVersion(orgId: string, kind: string, slug: string, version: string): Promise<StoredVersion> {
    const res = await this.pool.query(
      "SELECT v.manifest, v.object_key, v.bundle_sha256 FROM registry_versions v " +
      "JOIN registry_items i ON i.id = v.item_id " +
      "WHERE i.org_id = $1 AND i.kind = $2 AND i.slug = $3 AND v.version = $4",
      [orgId, kind, slug, version],
    );
    const row = res.rows[0];
    if (row === undefined) throw ApiError.notFound("no such registry version");
    return {
      manifest: row.manifest,
      object_key: row.object_key,
      bundle_sha256: row.bundle_sha256 ?? null,
    };
  }

  /** The version and bundle hash an approval covers: returned only while
   *  review_status is approved, the approval's recorded version still is
   *  the latest, AND the latest version row's stored bundle hash equals the
   *  approved one. */
  async approvedBundle(orgId: string, kind: string, slug: string): Promise<[string, string] | null> {
    const res = await this.pool.query(
      "SELECT i.latest_version, v.bundle_sha256 FROM registry_items i " +
      "JOIN registry_versions v ON v.item_id = i.id AND v.version = i.latest_version " +
      "WHERE i.org_id = $1 AND i.kind = $2 AND i.slug = $3 " +
      "AND i.review_status = 'approved' " +
      "AND i.reviewed_version = i.latest_version " +
      "AND i.reviewed_bundle_sha256 IS NOT NULL " +
      "AND i.reviewed_bundle_sha256 = v.bundle_sha256",
      [orgId, kind, slug],
    );
    const row = res.rows[0];
    if (row === undefined) return null;
    return [row.latest_version as string, row.bundle_sha256 as string];
  }

  /** Review status of an item ("draft"/"approved"); 404 when absent. */
  async reviewStatus(orgId: string, kind: string, slug: string): Promise<string> {
    const res = await this.pool.query(
      "SELECT review_status FROM registry_items WHERE org_id = $1 AND kind = $2 AND slug = $3",
      [orgId, kind, slug],
    );
    const row = res.rows[0];
    if (row === undefined) throw ApiError.notFound("no such registry item");
    return row.review_status as string;
  }

  /** Sets the review status. An approval must name the version and bundle
   *  hash the admin reviewed; the check runs under the item's FOR UPDATE
   *  lock, so a concurrent republish can never slide unreviewed content
   *  under an approve click. A retraction clears both bindings. */
  async setReview(
    orgId: string,
    kind: string,
    slug: string,
    status: string,
    reviewedVersion: string | null,
    reviewedBundleSha256: string | null,
  ): Promise<void> {
    return withTransaction(this.pool, async (client) => {
      const itemRes = await client.query<{ id: string; latest_version: string | null }>(
        "SELECT id, latest_version FROM registry_items WHERE org_id = $1 AND kind = $2 AND slug = $3 FOR UPDATE",
        [orgId, kind, slug],
      );
      const item = itemRes.rows[0];
      if (item === undefined) throw ApiError.notFound("no such registry item");
      let stampedVersion: string | null = null;
      let stampedSha: string | null = null;
      if (status === "approved") {
        if (reviewedVersion === null || reviewedBundleSha256 === null) {
          throw ApiError.badRequest("approval requires reviewed_version and reviewed_bundle_sha256");
        }
        if (item.latest_version !== reviewedVersion) {
          throw ApiError.conflict(
            "reviewed_version_stale",
            "the item's latest version changed since the review started — inspect it again",
          );
        }
        const shaRes = await client.query<{ bundle_sha256: string | null }>(
          "SELECT bundle_sha256 FROM registry_versions WHERE item_id = $1 AND version = $2",
          [item.id, reviewedVersion],
        );
        const storedSha = (shaRes.rows[0]?.bundle_sha256 as string | undefined) ?? null;
        if (storedSha !== reviewedBundleSha256) {
          throw ApiError.conflict(
            "reviewed_bundle_stale",
            "the bundle's content changed since the review started — inspect it again",
          );
        }
        stampedVersion = item.latest_version;
        stampedSha = reviewedBundleSha256;
      }
      await client.query(
        "UPDATE registry_items SET review_status = $2, reviewed_version = $3, reviewed_bundle_sha256 = $4 WHERE id = $1",
        [item.id, status, stampedVersion, stampedSha],
      );
    });
  }
}
