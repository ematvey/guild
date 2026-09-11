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
    pub member_count: i64,
}

pub struct TeamStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

impl<'a> TeamStore<'a> {
    pub async fn create_team(&self, org_id: Uuid, name: &str) -> Result<TeamRow, ApiError> {
        let id = Uuid::now_v7();
        match sqlx::query_as::<_, TeamRow>(
            "INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $3) \
             RETURNING id, org_id, name, created_at, 0::bigint AS member_count",
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
            "SELECT t.id, t.org_id, t.name, t.created_at, \
             COUNT(m.user_id)::bigint AS member_count \
             FROM teams t LEFT JOIN team_members m ON m.team_id = t.id \
             WHERE t.org_id = $1 GROUP BY t.id, t.org_id, t.name, t.created_at \
             ORDER BY t.created_at",
        )
        .bind(org_id)
        .fetch_all(self.pool)
        .await
        .map_err(Into::into)
    }

    pub async fn delete_team(&self, org_id: Uuid, team_id: Uuid) -> Result<(), ApiError> {
        let res = sqlx::query("DELETE FROM teams WHERE id = $1 AND org_id = $2")
            .bind(team_id)
            .bind(org_id)
            .execute(self.pool)
            .await?;
        if res.rows_affected() == 0 {
            return Err(ApiError::not_found("no such team"));
        }
        Ok(())
    }

    /// Members of a team; the team must belong to the org.
    pub async fn list_members(
        &self,
        org_id: Uuid,
        team_id: Uuid,
    ) -> Result<Vec<super::identity::UserListRow>, ApiError> {
        if !self.team_in_org(org_id, team_id).await? {
            return Err(ApiError::not_found("no such team"));
        }
        sqlx::query_as(
            "SELECT u.id, u.email, u.role, u.identity_type, u.created_at \
             FROM team_members m JOIN users u ON u.id = m.user_id \
             WHERE m.team_id = $1 ORDER BY u.created_at",
        )
        .bind(team_id)
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
        if !self.team_in_org(org_id, team_id).await? {
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

    pub async fn remove_member(
        &self,
        org_id: Uuid,
        team_id: Uuid,
        user_id: Uuid,
    ) -> Result<(), ApiError> {
        if !self.team_in_org(org_id, team_id).await? {
            return Err(ApiError::not_found("no such team"));
        }
        sqlx::query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2")
            .bind(team_id)
            .bind(user_id)
            .execute(self.pool)
            .await?;
        Ok(())
    }

    async fn team_in_org(&self, org_id: Uuid, team_id: Uuid) -> Result<bool, ApiError> {
        let org: Option<Uuid> = sqlx::query_scalar("SELECT org_id FROM teams WHERE id = $1")
            .bind(team_id)
            .fetch_optional(self.pool)
            .await?;
        Ok(org == Some(org_id))
    }
}
