//! Organization settings: the workspace's display name and logo. The logo
//! bytes live in object storage under `orgs/{org_id}/logo.{ext}`; the row
//! carries the serving URL.

use crate::http::error::ApiError;
use serde::Serialize;
use uuid::Uuid;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct OrgSettings {
    pub name: String,
    pub logo_url: Option<String>,
}

pub struct OrgStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

impl<'a> OrgStore<'a> {
    pub async fn get(&self, org_id: Uuid) -> Result<OrgSettings, ApiError> {
        sqlx::query_as::<_, (String, Option<String>)>(
            "SELECT name, logo_url FROM orgs WHERE id = $1",
        )
        .bind(org_id)
        .fetch_optional(self.pool)
        .await
        .map_err(ApiError::from)?
        .map(|(name, logo_url)| OrgSettings { name, logo_url })
        .ok_or_else(|| ApiError::not_found("organization not found"))
    }

    pub async fn set_name(&self, org_id: Uuid, name: &str) -> Result<(), ApiError> {
        sqlx::query("UPDATE orgs SET name = $2 WHERE id = $1")
            .bind(org_id)
            .bind(name)
            .execute(self.pool)
            .await
            .map_err(ApiError::from)
            .map(|_| ())
    }

    pub async fn set_logo_url(&self, org_id: Uuid, url: Option<&str>) -> Result<(), ApiError> {
        sqlx::query("UPDATE orgs SET logo_url = $2 WHERE id = $1")
            .bind(org_id)
            .bind(url)
            .execute(self.pool)
            .await
            .map_err(ApiError::from)
            .map(|_| ())
    }
}
