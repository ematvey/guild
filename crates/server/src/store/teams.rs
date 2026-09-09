//! Teams: org subgroups used for cost roll-ups and scoping (spec §4.1/§4.5).

use crate::http::error::ApiError;
use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct TeamRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub name: String,
    pub created_at: DateTime<Utc>,
}

pub struct TeamStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

impl<'a> TeamStore<'a> {
    pub async fn create_team(&self, org_id: Uuid, name: &str) -> Result<TeamRow, ApiError> {
        let id = Uuid::now_v7();
        match sqlx::query_as::<_, TeamRow>(
            "INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $3) \
             RETURNING id, org_id, name, created_at",
        )
        .bind(id)
        .bind(org_id)
        .bind(name)
        .fetch_one(self.pool)
        .await
        {
            Ok(t) => Ok(t),
            Err(sqlx::Error::Database(db)) if db.is_unique_violation() => Err(ApiError::conflict(
                "team_taken",
                "a team with this name already exists",
            )),
            Err(e) => Err(ApiError::from(e)),
        }
    }

    pub async fn list_teams(&self, org_id: Uuid) -> Result<Vec<TeamRow>, ApiError> {
        sqlx::query_as(
            "SELECT id, org_id, name, created_at FROM teams WHERE org_id = $1 ORDER BY created_at",
        )
        .bind(org_id)
        .fetch_all(self.pool)
        .await
        .map_err(Into::into)
    }

    pub async fn add_member(
        &self,
        org_id: Uuid,
        team_id: Uuid,
        user_id: Uuid,
    ) -> Result<(), ApiError> {
        // team must belong to the org; user too (enforced by FKs + checks here)
        let team_org: Option<Uuid> = sqlx::query_scalar("SELECT org_id FROM teams WHERE id = $1")
            .bind(team_id)
            .fetch_optional(self.pool)
            .await?;
        if team_org != Some(org_id) {
            return Err(ApiError::not_found("no such team"));
        }
        let user_org: Option<Uuid> = sqlx::query_scalar("SELECT org_id FROM users WHERE id = $1")
            .bind(user_id)
            .fetch_optional(self.pool)
            .await?;
        if user_org != Some(org_id) {
            return Err(ApiError::bad_request("user is not in this org"));
        }
        sqlx::query(
            "INSERT INTO team_members (team_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        )
        .bind(team_id)
        .bind(user_id)
        .execute(self.pool)
        .await?;
        Ok(())
    }
}
