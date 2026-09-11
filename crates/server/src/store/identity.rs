//! Orgs, users (managed accounts), sessions — spec §4.1.

use crate::http::error::ApiError;
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::http::StatusCode;
use chrono::{Duration, Utc};
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UserRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub email: String,
    pub role: String,
}

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct UserListRow {
    pub id: Uuid,
    pub email: String,
    pub role: String,
    pub identity_type: String,
    pub created_at: chrono::DateTime<Utc>,
}

#[derive(Debug, sqlx::FromRow)]
struct AuthRow {
    id: Uuid,
    org_id: Uuid,
    email: String,
    role: String,
    password_hash: String,
}

pub struct IdentityStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

fn hash_password(password: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut rand_core::OsRng);
    Ok(Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| anyhow::anyhow!("argon2 hash failed: {e}"))?
        .to_string())
}

fn verify_password(password: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(parsed) => Argon2::default()
            .verify_password(password.as_bytes(), &parsed)
            .is_ok(),
        Err(_) => false,
    }
}

fn random_token() -> String {
    use rand::RngCore;
    let mut buf = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut buf);
    hex::encode(buf)
}

impl<'a> IdentityStore<'a> {
    /// Creates the first org + admin user. No-op if users already exist; in
    /// that case resolves the user by email (error if email is new).
    pub async fn ensure_bootstrap_admin(
        &self,
        email: &str,
        password: &str,
    ) -> anyhow::Result<Uuid> {
        let user: Option<UserRow> =
            sqlx::query_as("SELECT id, org_id, email, role FROM users WHERE email = $1")
                .bind(email)
                .fetch_optional(self.pool)
                .await?;
        if let Some(u) = user {
            return Ok(u.id);
        }
        let any: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(self.pool)
            .await?;
        anyhow::ensure!(any == 0, "org already has users");
        let org_id = Uuid::now_v7();
        let user_id = Uuid::now_v7();
        let hash = hash_password(password)?;
        let mut tx = self.pool.begin().await?;
        sqlx::query("INSERT INTO orgs (id, name) VALUES ($1, $2)")
            .bind(org_id)
            .bind("org")
            .execute(&mut *tx)
            .await?;
        sqlx::query(
            "INSERT INTO users (id, org_id, email, password_hash, role, identity_type) \
             VALUES ($1, $2, $3, $4, 'admin', 'managed')",
        )
        .bind(user_id)
        .bind(org_id)
        .bind(email)
        .bind(hash)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(user_id)
    }

    pub async fn create_user(
        &self,
        org_id: Uuid,
        email: &str,
        password: &str,
        role: &str,
    ) -> Result<UserRow, ApiError> {
        let hash = hash_password(password).map_err(ApiError::from)?;
        let id = Uuid::now_v7();
        let row: Result<UserRow, sqlx::Error> = sqlx::query_as(
            "INSERT INTO users (id, org_id, email, password_hash, role, identity_type) \
             VALUES ($1, $2, $3, $4, $5, 'managed') \
             RETURNING id, org_id, email, role",
        )
        .bind(id)
        .bind(org_id)
        .bind(email)
        .bind(hash)
        .bind(role)
        .fetch_one(self.pool)
        .await;
        match row {
            Ok(u) => {
                // org event: member joined (spec §4.6); best-effort
                let events = crate::store::events::EventStore { pool: self.pool };
                let _ = events
                    .emit(
                        org_id,
                        "member.joined",
                        serde_json::json!({ "email": email, "user_id": u.id }),
                    )
                    .await;
                Ok(u)
            }
            Err(sqlx::Error::Database(db)) if db.is_unique_violation() => Err(ApiError::conflict(
                "email_taken",
                "a user with this email already exists",
            )),
            Err(e) => Err(ApiError::from(e)),
        }
    }

    /// Finds an existing user by email within an org (any identity type).
    pub async fn find_by_email(
        &self,
        org_id: Uuid,
        email: &str,
    ) -> Result<Option<UserRow>, ApiError> {
        sqlx::query_as("SELECT id, org_id, email, role FROM users WHERE org_id = $1 AND email = $2")
            .bind(org_id)
            .bind(email)
            .fetch_optional(self.pool)
            .await
            .map_err(Into::into)
    }

    /// Provisions an OIDC user (random unusable password, member role).
    /// Email lookup across orgs (bootstrap/single-org flows).
    pub async fn find_by_email_any(&self, email: &str) -> anyhow::Result<Option<UserRow>> {
        let user: Option<UserRow> =
            sqlx::query_as("SELECT id, org_id, email, role FROM users WHERE email = $1")
                .bind(email)
                .fetch_optional(self.pool)
                .await?;
        Ok(user)
    }

    pub async fn get_user(&self, id: Uuid) -> Result<UserRow, ApiError> {
        sqlx::query_as("SELECT id, org_id, email, role FROM users WHERE id = $1")
            .bind(id)
            .fetch_optional(self.pool)
            .await?
            .ok_or_else(|| ApiError::not_found("no such user"))
    }

    /// The user's approval policy (or `None` → server default: default Ask,
    /// read-only tools allowed). User-scoped since 0026: tool trust belongs
    /// to the user and their bound machine, not to an individual chat.
    pub async fn approval(&self, user_id: Uuid) -> Result<Option<serde_json::Value>, ApiError> {
        // Distinguish "no such user" (None row) from "user with NULL policy"
        // (Some(None)) — the latter is the normal server-default case.
        let row: Option<Option<serde_json::Value>> =
            sqlx::query_scalar("SELECT approval FROM users WHERE id = $1")
                .bind(user_id)
                .fetch_optional(self.pool)
                .await?;
        match row {
            None => Err(ApiError::not_found("no such user")),
            Some(inner) => Ok(inner),
        }
    }

    /// Stores (or with `None`, clears) the user's approval policy.
    pub async fn set_approval(
        &self,
        user_id: Uuid,
        approval: Option<serde_json::Value>,
    ) -> Result<(), ApiError> {
        sqlx::query("UPDATE users SET approval = $2 WHERE id = $1")
            .bind(user_id)
            .bind(approval)
            .execute(self.pool)
            .await
            .map_err(Into::into)
            .map(|_| ())
    }

    pub async fn create_oidc_user(&self, org_id: Uuid, email: &str) -> Result<UserRow, ApiError> {
        use rand::RngCore;
        let mut bytes = [0u8; 24];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let unusable = hex::encode(bytes);
        let hash = hash_password(&unusable).map_err(ApiError::from)?;
        let id = Uuid::now_v7();
        sqlx::query_as(
            "INSERT INTO users (id, org_id, email, password_hash, role, identity_type)              VALUES ($1, $2, $3, $4, 'member', 'oidc')              RETURNING id, org_id, email, role",
        )
        .bind(id)
        .bind(org_id)
        .bind(email)
        .bind(hash)
        .fetch_one(self.pool)
        .await
        .map_err(Into::into)
    }

    pub async fn authenticate(&self, email: &str, password: &str) -> Result<UserRow, ApiError> {
        let row: Option<AuthRow> = sqlx::query_as(
            "SELECT id, org_id, email, role, password_hash FROM users WHERE email = $1",
        )
        .bind(email)
        .fetch_optional(self.pool)
        .await?;
        let Some(auth) = row else {
            return Err(ApiError::new(
                StatusCode::UNAUTHORIZED,
                "invalid_credentials",
                "invalid email or password",
            ));
        };
        if !verify_password(password, &auth.password_hash) {
            return Err(ApiError::new(
                StatusCode::UNAUTHORIZED,
                "invalid_credentials",
                "invalid email or password",
            ));
        }
        Ok(UserRow {
            id: auth.id,
            org_id: auth.org_id,
            email: auth.email,
            role: auth.role,
        })
    }

    pub async fn create_session(&self, user_id: Uuid) -> anyhow::Result<(Uuid, String)> {
        // session id is derived: we generate token first, use v7 id for bookkeeping
        let token = random_token();
        let id = Uuid::now_v7();
        let expires = Utc::now() + Duration::days(30);
        sqlx::query("INSERT INTO sessions (token, user_id, expires_at) VALUES ($1, $2, $3)")
            .bind(&token)
            .bind(user_id)
            .bind(expires)
            .execute(self.pool)
            .await?;
        Ok((id, token))
    }

    pub async fn validate_session(&self, token: &str) -> Result<UserRow, ApiError> {
        sqlx::query_as(
            "SELECT u.id, u.org_id, u.email, u.role FROM sessions s \
             JOIN users u ON u.id = s.user_id \
             WHERE s.token = $1 AND s.revoked_at IS NULL AND s.expires_at > now()",
        )
        .bind(token)
        .fetch_optional(self.pool)
        .await?
        .ok_or_else(|| ApiError::unauthorized("invalid or expired session"))
    }

    pub async fn revoke_session(&self, token: &str) -> anyhow::Result<()> {
        sqlx::query("UPDATE sessions SET revoked_at = now() WHERE token = $1")
            .bind(token)
            .execute(self.pool)
            .await?;
        Ok(())
    }

    pub async fn list_users(&self, org_id: Uuid) -> Result<Vec<UserListRow>, ApiError> {
        sqlx::query_as(
            "SELECT id, email, role, identity_type, created_at FROM users WHERE org_id = $1 ORDER BY created_at",
        )
        .bind(org_id)
        .fetch_all(self.pool)
        .await
        .map_err(Into::into)
    }

    /// Updates a managed user (role change and/or password reset); omitted
    /// fields stay unchanged. The user must belong to the org.
    pub async fn update_user(
        &self,
        org_id: Uuid,
        user_id: Uuid,
        role: Option<&str>,
        password: Option<&str>,
    ) -> Result<UserListRow, ApiError> {
        let hash = match password {
            Some(p) => Some(hash_password(p).map_err(ApiError::from)?),
            None => None,
        };
        sqlx::query_as(
            "UPDATE users SET role = COALESCE($2::text, role), \
             password_hash = COALESCE($3::text, password_hash) \
             WHERE id = $1 AND org_id = $4 \
             RETURNING id, email, role, identity_type, created_at",
        )
        .bind(user_id)
        .bind(role)
        .bind(hash)
        .bind(org_id)
        .fetch_optional(self.pool)
        .await?
        .ok_or_else(|| ApiError::not_found("no such user"))
    }

    /// Deletes a user; refuses to remove the org's last admin.
    pub async fn delete_user(&self, org_id: Uuid, user_id: Uuid) -> Result<(), ApiError> {
        let target: Option<(String,)> =
            sqlx::query_as("SELECT role FROM users WHERE org_id = $1 AND id = $2")
                .bind(org_id)
                .bind(user_id)
                .fetch_optional(self.pool)
                .await?;
        let Some((role,)) = target else {
            return Err(ApiError::not_found("no such user"));
        };
        if role == "admin" {
            let admins: i64 = sqlx::query_scalar(
                "SELECT COUNT(*) FROM users WHERE org_id = $1 AND role = 'admin'",
            )
            .bind(org_id)
            .fetch_one(self.pool)
            .await?;
            if admins <= 1 {
                return Err(ApiError::conflict(
                    "last_admin",
                    "cannot delete the last admin",
                ));
            }
        }
        sqlx::query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1")
            .bind(user_id)
            .execute(self.pool)
            .await?;
        sqlx::query("DELETE FROM users WHERE id = $1")
            .bind(user_id)
            .execute(self.pool)
            .await?;
        Ok(())
    }

    pub async fn any_users(&self) -> anyhow::Result<bool> {
        let n: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(self.pool)
            .await?;
        Ok(n > 0)
    }
}

#[cfg(all(test, feature = "test-support"))]
mod tests {
    use crate::store::Store;

    #[tokio::test]
    async fn bootstrap_admin_once_then_login_and_session() {
        let db = Store::connect_test().await.unwrap();
        let store = &db.store;
        let admin_email = "admin@example.org";
        let user_id = store
            .identity()
            .ensure_bootstrap_admin(admin_email, "hunter226")
            .await
            .unwrap();
        let again = store
            .identity()
            .ensure_bootstrap_admin(admin_email, "other")
            .await
            .unwrap();
        assert_eq!(user_id, again);

        let user = store
            .identity()
            .authenticate(admin_email, "hunter226")
            .await
            .unwrap();
        assert_eq!(user.role, "admin");
        assert!(store
            .identity()
            .authenticate(admin_email, "wrong")
            .await
            .is_err());

        let (_sid, token) = store.identity().create_session(user.id).await.unwrap();
        let validated = store.identity().validate_session(&token).await.unwrap();
        assert_eq!(validated.id, user.id);
        store.identity().revoke_session(&token).await.unwrap();
        assert!(store.identity().validate_session(&token).await.is_err());
    }
}
