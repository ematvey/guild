//! Registry records: org-scoped catalogs for skills, MCP servers, and
//! integrations (spec §4.4).

use crate::http::error::ApiError;
use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct RegistryItemRow {
    pub slug: String,
    pub description: String,
    pub latest_version: Option<String>,
    pub review_status: String,
}

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct VersionRow {
    pub version: String,
    pub published_at: DateTime<Utc>,
    pub bundle_sha256: Option<String>,
}

pub struct RegistryStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

pub struct StoredVersion {
    pub manifest: serde_json::Value,
    pub object_key: String,
    pub bundle_sha256: Option<String>,
}

impl<'a> RegistryStore<'a> {
    /// Publishes (or republishes) a version. Any change to a version row's
    /// manifest OR bundle hash resets the item's review status to draft —
    /// the approval attaches to the exact reviewed manifest and bundle
    /// bytes, so altered content must be re-reviewed before it governs
    /// resolution. An unchanged re-upload (same manifest, same bundle hash)
    /// of the current version keeps the status only when the standing
    /// approval is actually bound to content (`reviewed_version` set): a
    /// pre-binding approval counts as no approval and resets to draft.
    /// Republishing an older version is refused: it would overwrite a
    /// superseded release and regress latest_version. The item row is read
    /// and locked inside the transaction (no TOCTOU).
    #[allow(clippy::too_many_arguments)]
    pub async fn upsert_version(
        &self,
        org_id: Uuid,
        kind: &str,
        slug: &str,
        version: &str,
        description: &str,
        manifest: serde_json::Value,
        object_key: &str,
        bundle_sha256: &str,
        publisher: Uuid,
    ) -> Result<(), ApiError> {
        let mut tx = self.pool.begin().await?;
        let item: Option<(Uuid, Option<String>, String, Option<String>)> = sqlx::query_as(
            "SELECT id, latest_version, review_status, reviewed_version FROM registry_items \
             WHERE org_id = $1 AND kind = $2 AND slug = $3 FOR UPDATE",
        )
        .bind(org_id)
        .bind(kind)
        .bind(slug)
        .fetch_optional(&mut *tx)
        .await?;
        let item_id = match item {
            Some((id, latest, status, item_reviewed_version)) => {
                // Guard: an already-published version that is no longer the
                // latest is superseded — republishing it would overwrite the
                // old release's bundle and regress latest_version. Brand-new
                // versions pass and advance latest.
                if latest.as_deref() != Some(version) {
                    let exists: Option<i64> = sqlx::query_scalar(
                        "SELECT 1::int8 FROM registry_versions WHERE item_id = $1 AND version = $2",
                    )
                    .bind(id)
                    .bind(version)
                    .fetch_optional(&mut *tx)
                    .await?;
                    if exists.is_some() {
                        return Err(ApiError::conflict(
                            "version_superseded",
                            "this version was already superseded by a newer release — publish a new version instead",
                        ));
                    }
                }
                // An unchanged re-upload of the current version (same
                // manifest, same bundle bytes) keeps the review status only
                // while the standing approval is bound to content; any
                // manifest change, bundle-byte change, new version, or an
                // unbound pre-existing approval resets to draft and drops
                // the approval's version + hash binding.
                let previous: Option<(serde_json::Value, Option<String>)> = sqlx::query_as(
                    "SELECT manifest, bundle_sha256 FROM registry_versions \
                     WHERE item_id = $1 AND version = $2",
                )
                .bind(id)
                .bind(version)
                .fetch_optional(&mut *tx)
                .await?;
                let unchanged = previous.as_ref().is_some_and(|(prev_manifest, prev_sha)| {
                    prev_manifest == &manifest && prev_sha.as_deref() == Some(bundle_sha256)
                });
                let approval_bound = item_reviewed_version.is_some()
                    && item_reviewed_version.as_deref() == latest.as_deref();
                let status = if unchanged
                    && latest.as_deref() == Some(version)
                    && (status != "approved" || approval_bound)
                {
                    status
                } else {
                    "draft".into()
                };
                sqlx::query(
                    "UPDATE registry_items SET latest_version = $2, description = $3, review_status = $4, \
                     reviewed_version = CASE WHEN $4 = 'approved' THEN latest_version ELSE NULL END, \
                     reviewed_bundle_sha256 = CASE WHEN $4 = 'approved' THEN $5 ELSE NULL END \
                     WHERE id = $1",
                )
                .bind(id)
                .bind(version)
                .bind(description)
                .bind(status)
                .bind(bundle_sha256)
                .execute(&mut *tx)
                .await?;
                id
            }
            None => {
                let id = Uuid::now_v7();
                sqlx::query(
                    "INSERT INTO registry_items (id, org_id, kind, slug, description, latest_version) \
                     VALUES ($1, $2, $3, $4, $5, $6)",
                )
                .bind(id)
                .bind(org_id)
                .bind(kind)
                .bind(slug)
                .bind(description)
                .bind(version)
                .execute(&mut *tx)
                .await?;
                id
            }
        };
        sqlx::query(
            "INSERT INTO registry_versions (id, item_id, version, manifest, object_key, bundle_sha256, published_by) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) \
             ON CONFLICT (item_id, version) \
             DO UPDATE SET manifest = EXCLUDED.manifest, object_key = EXCLUDED.object_key, \
               bundle_sha256 = EXCLUDED.bundle_sha256, published_by = EXCLUDED.published_by, \
               published_at = now()",
        )
        .bind(Uuid::now_v7())
        .bind(item_id)
        .bind(version)
        .bind(manifest)
        .bind(object_key)
        .bind(bundle_sha256)
        .bind(publisher)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    pub async fn list_items(
        &self,
        org_id: Uuid,
        kind: &str,
    ) -> Result<Vec<RegistryItemRow>, ApiError> {
        sqlx::query_as(
            "SELECT slug, description, latest_version, review_status FROM registry_items \
             WHERE org_id = $1 AND kind = $2 ORDER BY slug",
        )
        .bind(org_id)
        .bind(kind)
        .fetch_all(self.pool)
        .await
        .map_err(Into::into)
    }

    pub async fn item_versions(
        &self,
        org_id: Uuid,
        kind: &str,
        slug: &str,
    ) -> Result<Vec<VersionRow>, ApiError> {
        sqlx::query_as(
            "SELECT v.version, v.published_at, v.bundle_sha256 FROM registry_versions v \
             JOIN registry_items i ON i.id = v.item_id \
             WHERE i.org_id = $1 AND i.kind = $2 AND i.slug = $3 ORDER BY v.published_at DESC",
        )
        .bind(org_id)
        .bind(kind)
        .bind(slug)
        .fetch_all(self.pool)
        .await
        .map_err(Into::into)
    }

    pub async fn get_version(
        &self,
        org_id: Uuid,
        kind: &str,
        slug: &str,
        version: &str,
    ) -> Result<StoredVersion, ApiError> {
        sqlx::query_as::<_, (serde_json::Value, String, Option<String>)>(
            "SELECT v.manifest, v.object_key, v.bundle_sha256 FROM registry_versions v \
             JOIN registry_items i ON i.id = v.item_id \
             WHERE i.org_id = $1 AND i.kind = $2 AND i.slug = $3 AND v.version = $4",
        )
        .bind(org_id)
        .bind(kind)
        .bind(slug)
        .bind(version)
        .fetch_optional(self.pool)
        .await?
        .map(|(manifest, object_key, bundle_sha256)| StoredVersion {
            manifest,
            object_key,
            bundle_sha256,
        })
        .ok_or_else(|| ApiError::not_found("no such registry version"))
    }

    /// The version and bundle hash an approval covers: returned only while
    /// review_status is approved, the approval's recorded version still is
    /// the latest, AND the latest version row's stored bundle hash equals
    /// the approved one — a republish (manifest or bytes) resets the status,
    /// so unreviewed content never resolves, downloads, or installs.
    pub async fn approved_bundle(
        &self,
        org_id: Uuid,
        kind: &str,
        slug: &str,
    ) -> Result<Option<(String, String)>, ApiError> {
        sqlx::query_as(
            "SELECT i.latest_version, v.bundle_sha256 FROM registry_items i \
             JOIN registry_versions v ON v.item_id = i.id AND v.version = i.latest_version \
             WHERE i.org_id = $1 AND i.kind = $2 AND i.slug = $3 \
               AND i.review_status = 'approved' \
               AND i.reviewed_version = i.latest_version \
               AND i.reviewed_bundle_sha256 IS NOT NULL \
               AND i.reviewed_bundle_sha256 = v.bundle_sha256",
        )
        .bind(org_id)
        .bind(kind)
        .bind(slug)
        .fetch_optional(self.pool)
        .await
        .map_err(Into::into)
    }

    /// Review status of an item ("draft"/"approved"); 404 when absent.
    pub async fn review_status(
        &self,
        org_id: Uuid,
        kind: &str,
        slug: &str,
    ) -> Result<String, ApiError> {
        sqlx::query_scalar(
            "SELECT review_status FROM registry_items WHERE org_id = $1 AND kind = $2 AND slug = $3",
        )
        .bind(org_id)
        .bind(kind)
        .bind(slug)
        .fetch_optional(self.pool)
        .await?
        .ok_or_else(|| ApiError::not_found("no such registry item"))
    }

    /// Sets the review status. An approval must name the version and bundle
    /// hash the admin reviewed: both are stamped in the same statement, and
    /// the check runs under the item's FOR UPDATE lock — if the latest
    /// version (or its bundle bytes) changed since the review started, the
    /// approval is refused with a conflict so a concurrent republish can
    /// never slide unreviewed content under an approve click. A retraction
    /// clears both bindings.
    pub async fn set_review(
        &self,
        org_id: Uuid,
        kind: &str,
        slug: &str,
        status: &str,
        reviewed_version: Option<&str>,
        reviewed_bundle_sha256: Option<&str>,
    ) -> Result<(), ApiError> {
        let mut tx = self.pool.begin().await?;
        let item: Option<(Uuid, Option<String>)> = sqlx::query_as(
            "SELECT id, latest_version FROM registry_items \
             WHERE org_id = $1 AND kind = $2 AND slug = $3 FOR UPDATE",
        )
        .bind(org_id)
        .bind(kind)
        .bind(slug)
        .fetch_optional(&mut *tx)
        .await?;
        let (item_id, latest) = match item {
            Some(v) => v,
            None => return Err(ApiError::not_found("no such registry item")),
        };
        let (stamped_version, stamped_sha) = if status == "approved" {
            let (version, sha) = match (reviewed_version, reviewed_bundle_sha256) {
                (Some(v), Some(h)) => (v, h),
                _ => {
                    return Err(ApiError::bad_request(
                        "approval requires reviewed_version and reviewed_bundle_sha256",
                    ))
                }
            };
            if latest.as_deref() != Some(version) {
                return Err(ApiError::conflict(
                    "reviewed_version_stale",
                    "the item's latest version changed since the review started — inspect it again",
                ));
            }
            let stored_sha: Option<String> = sqlx::query_scalar(
                "SELECT bundle_sha256 FROM registry_versions \
                 WHERE item_id = $1 AND version = $2",
            )
            .bind(item_id)
            .bind(version)
            .fetch_optional(&mut *tx)
            .await?
            .flatten();
            if stored_sha.as_deref() != Some(sha) {
                return Err(ApiError::conflict(
                    "reviewed_bundle_stale",
                    "the bundle's content changed since the review started — inspect it again",
                ));
            }
            (
                Some(latest.clone().expect("latest checked above")),
                sha.to_string(),
            )
        } else {
            (None, String::new())
        };
        let sha_param = if status == "approved" {
            Some(stamped_sha.as_str())
        } else {
            None
        };
        sqlx::query(
            "UPDATE registry_items SET review_status = $2, \
             reviewed_version = $3, reviewed_bundle_sha256 = $4 WHERE id = $1",
        )
        .bind(item_id)
        .bind(status)
        .bind(stamped_version)
        .bind(sha_param)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }
}
