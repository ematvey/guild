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
}

pub struct RegistryStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

pub struct StoredVersion {
    pub manifest: serde_json::Value,
    pub object_key: String,
}

impl<'a> RegistryStore<'a> {
    /// Publishes (or republishes) a version. Any change to a version row's
    /// manifest resets the item's review status to draft — the approval
    /// attaches to the exact reviewed manifest, so altered content must be
    /// re-reviewed before it governs resolution (republishing the current
    /// version with an unchanged manifest keeps the status). Republishing an
    /// older version is refused: it would overwrite a superseded release and
    /// regress latest_version. The item row is read and locked inside the
    /// transaction (no TOCTOU).
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
        publisher: Uuid,
    ) -> Result<(), ApiError> {
        let mut tx = self.pool.begin().await?;
        let item: Option<(Uuid, Option<String>, String)> = sqlx::query_as(
            "SELECT id, latest_version, review_status FROM registry_items \
             WHERE org_id = $1 AND kind = $2 AND slug = $3 FOR UPDATE",
        )
        .bind(org_id)
        .bind(kind)
        .bind(slug)
        .fetch_optional(&mut *tx)
        .await?;
        let item_id = match item {
            Some((id, latest, status)) => {
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
                // An unchanged re-upload of the current version keeps the
                // review status; any manifest change (or a new version)
                // resets to draft and drops the approval's version binding.
                let previous: Option<serde_json::Value> = sqlx::query_scalar(
                    "SELECT manifest FROM registry_versions WHERE item_id = $1 AND version = $2",
                )
                .bind(id)
                .bind(version)
                .fetch_optional(&mut *tx)
                .await?;
                let unchanged = previous.as_ref() == Some(&manifest);
                let status = if unchanged && latest.as_deref() == Some(version) {
                    status
                } else {
                    "draft".into()
                };
                sqlx::query(
                    "UPDATE registry_items SET latest_version = $2, description = $3, review_status = $4, \
                     reviewed_version = CASE WHEN $4 = 'approved' THEN latest_version ELSE NULL END \
                     WHERE id = $1",
                )
                .bind(id)
                .bind(version)
                .bind(description)
                .bind(status)
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
            "INSERT INTO registry_versions (id, item_id, version, manifest, object_key, published_by) \
             VALUES ($1, $2, $3, $4, $5, $6) \
             ON CONFLICT (item_id, version) \
             DO UPDATE SET manifest = EXCLUDED.manifest, object_key = EXCLUDED.object_key, \
               published_by = EXCLUDED.published_by, published_at = now()",
        )
        .bind(Uuid::now_v7())
        .bind(item_id)
        .bind(version)
        .bind(manifest)
        .bind(object_key)
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
            "SELECT v.version, v.published_at FROM registry_versions v \
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
        sqlx::query_as::<_, (serde_json::Value, String)>(
            "SELECT v.manifest, v.object_key FROM registry_versions v \
             JOIN registry_items i ON i.id = v.item_id \
             WHERE i.org_id = $1 AND i.kind = $2 AND i.slug = $3 AND v.version = $4",
        )
        .bind(org_id)
        .bind(kind)
        .bind(slug)
        .bind(version)
        .fetch_optional(self.pool)
        .await?
        .map(|(manifest, object_key)| StoredVersion {
            manifest,
            object_key,
        })
        .ok_or_else(|| ApiError::not_found("no such registry version"))
    }

    /// The version an approval covers: the latest version, but only while
    /// review_status is approved and the approval's recorded version still
    /// is the latest — a republish resets the status, so unreviewed content
    /// never resolves.
    pub async fn approved_version(
        &self,
        org_id: Uuid,
        kind: &str,
        slug: &str,
    ) -> Result<Option<String>, ApiError> {
        sqlx::query_scalar(
            "SELECT latest_version FROM registry_items \
             WHERE org_id = $1 AND kind = $2 AND slug = $3 \
               AND review_status = 'approved' AND reviewed_version = latest_version",
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

    /// Sets the review status. An approval records the item's current
    /// latest_version in the same statement, so the approval and the version
    /// it covers cannot drift apart; a retraction clears the binding.
    pub async fn set_review(
        &self,
        org_id: Uuid,
        kind: &str,
        slug: &str,
        status: &str,
    ) -> Result<(), ApiError> {
        let updated = sqlx::query(
            "UPDATE registry_items SET review_status = $4, \
             reviewed_version = CASE WHEN $4 = 'approved' THEN latest_version ELSE NULL END \
             WHERE org_id = $1 AND kind = $2 AND slug = $3",
        )
        .bind(org_id)
        .bind(kind)
        .bind(slug)
        .bind(status)
        .execute(self.pool)
        .await?
        .rows_affected();
        if updated == 0 {
            return Err(ApiError::not_found("no such registry item"));
        }
        Ok(())
    }
}
