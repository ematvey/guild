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
    /// Publishes (or republishes) a version. New versions of an approved
    /// item reset to draft; republishing the current version keeps status.
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
        let item: Option<(Uuid, Option<String>, String)> = sqlx::query_as(
            "SELECT id, latest_version, review_status FROM registry_items \
             WHERE org_id = $1 AND kind = $2 AND slug = $3",
        )
        .bind(org_id)
        .bind(kind)
        .bind(slug)
        .fetch_optional(self.pool)
        .await?;
        let mut tx = self.pool.begin().await?;
        let item_id = match item {
            Some((id, latest, status)) => {
                let status = if latest.as_deref() == Some(version) {
                    status
                } else {
                    "draft".into()
                };
                sqlx::query(
                    "UPDATE registry_items SET latest_version = $2, description = $3, review_status = $4 WHERE id = $1",
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

    pub async fn set_review(
        &self,
        org_id: Uuid,
        kind: &str,
        slug: &str,
        status: &str,
    ) -> Result<(), ApiError> {
        let updated = sqlx::query(
            "UPDATE registry_items SET review_status = $4 WHERE org_id = $1 AND kind = $2 AND slug = $3",
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
