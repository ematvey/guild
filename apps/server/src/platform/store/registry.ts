// Registry records: org-scoped catalogs for skills, MCP servers, and
// integrations (crates/server/src/store/registry.rs over the existing
// registry_items/registry_versions tables).

import { ApiError } from "../errors.js";
import { pgTimestampToRfc3339 } from "../time.js";
import { uuidv7 } from "../time.js";
import type { PlatformPool } from "../db.js";

export interface RegistryItemRow {
  slug: string;
  description: string;
  latest_version: string | null;
  review_status: string;
}

export interface VersionRow {
  version: string;
  published_at: string;
  bundle_sha256: string | null;
}

export interface StoredVersion {
  manifest: unknown;
  object_key: string;
  bundle_sha256: string | null;
}

/** Canonical JSON text for structural Value equality (key order ignored —
 *  serde_json::Value equality and Postgres JSONB normalization are both
 *  order-insensitive). */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
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

export class RegistryStore {
  constructor(readonly pool: PlatformPool) {}

  /** Publishes (or republishes) a version. Any change to a version row's
   *  manifest OR bundle hash resets the item's review status to draft —
   *  the approval attaches to the exact reviewed manifest and bundle
   *  bytes. An unchanged re-upload keeps the status only while the standing
   *  approval is bound to content. Republishing an older version is
   *  refused: it would overwrite a superseded release. The item row is
   *  read and locked inside the transaction (no TOCTOU). */
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
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const itemRes = await client.query<{ id: string; latest_version: string | null; review_status: string; reviewed_version: string | null }>(
        "SELECT id, latest_version, review_status, reviewed_version FROM registry_items " +
        "WHERE org_id = $1 AND kind = $2 AND slug = $3 FOR UPDATE",
        [orgId, kind, slug],
      );
      let itemId: string;
      const item = itemRes.rows[0];
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
          "INSERT INTO registry_items (id, org_id, kind, slug, description, latest_version) " +
          "VALUES ($1, $2, $3, $4, $5, $6)",
          [itemId, orgId, kind, slug, description, version],
        );
      }
      await client.query(
        "INSERT INTO registry_versions (id, item_id, version, manifest, object_key, bundle_sha256, published_by) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7) " +
        "ON CONFLICT (item_id, version) " +
        "DO UPDATE SET manifest = EXCLUDED.manifest, object_key = EXCLUDED.object_key, " +
        "bundle_sha256 = EXCLUDED.bundle_sha256, published_by = EXCLUDED.published_by, " +
        "published_at = now()",
        [uuidv7(), itemId, version, JSON.stringify(manifest), objectKey, bundleSha256, publisher],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async listItems(orgId: string, kind: string): Promise<RegistryItemRow[]> {
    const res = await this.pool.query(
      "SELECT slug, description, latest_version, review_status FROM registry_items " +
      "WHERE org_id = $1 AND kind = $2 ORDER BY slug",
      [orgId, kind],
    );
    return res.rows.map(itemRow);
  }

  async itemVersions(orgId: string, kind: string, slug: string): Promise<VersionRow[]> {
    const res = await this.pool.query(
      "SELECT v.version, to_char(v.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS published_at, v.bundle_sha256 " +
      "FROM registry_versions v JOIN registry_items i ON i.id = v.item_id " +
      "WHERE i.org_id = $1 AND i.kind = $2 AND i.slug = $3 ORDER BY v.published_at DESC",
      [orgId, kind, slug],
    );
    return res.rows.map((r: Record<string, unknown>) => ({
      version: r.version as string,
      published_at: pgTimestampToRfc3339(r.published_at as string),
      bundle_sha256: (r.bundle_sha256 as string | null) ?? null,
    }));
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
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
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
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
