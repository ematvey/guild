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
    pub identity_type: String,
    pub display_name: Option<String>,
    pub avatar_url: Option<String>,
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
    identity_type: String,
    password_hash: String,
    display_name: Option<String>,
    avatar_url: Option<String>,
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

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    hex::encode(Sha256::digest(data))
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
        // The check-and-insert runs under an advisory lock inside one
        // transaction: two concurrent bootstraps must not both pass the
        // "no users yet" check.
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(hashtext('guild:bootstrap'))")
            .execute(&mut *tx)
            .await?;
        let user: Option<UserRow> =
            sqlx::query_as("SELECT id, org_id, email, role, identity_type, display_name, avatar_url FROM users WHERE email = $1")
                .bind(email)
                .fetch_optional(&mut *tx)
                .await?;
        if let Some(u) = user {
            return Ok(u.id);
        }
        let any: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM users")
            .fetch_one(&mut *tx)
            .await?;
        anyhow::ensure!(any == 0, "org already has users");
        // Defense in depth beyond the HTTP handler: a bootstrap credential
        // never hashes below the admin-account minimum (the existing-user
        // early return above leaves reconnect flows untouched).
        anyhow::ensure!(
            password.chars().count() >= 8,
            "password must be at least 8 characters"
        );
        let org_id = Uuid::now_v7();
        let user_id = Uuid::now_v7();
        let hash = hash_password(password)?;
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
             RETURNING id, org_id, email, role, identity_type, display_name, avatar_url",
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
        sqlx::query_as("SELECT id, org_id, email, role, identity_type, display_name, avatar_url FROM users WHERE org_id = $1 AND email = $2")
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
            sqlx::query_as("SELECT id, org_id, email, role, identity_type, display_name, avatar_url FROM users WHERE email = $1")
                .bind(email)
                .fetch_optional(self.pool)
                .await?;
        Ok(user)
    }

    pub async fn get_user(&self, id: Uuid) -> Result<UserRow, ApiError> {
        sqlx::query_as("SELECT id, org_id, email, role, identity_type, display_name, avatar_url FROM users WHERE id = $1")
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

    pub async fn create_oidc_user(
        &self,
        org_id: Uuid,
        email: &str,
        display_name: Option<&str>,
        avatar_url: Option<&str>,
    ) -> Result<UserRow, ApiError> {
        use rand::RngCore;
        let mut bytes = [0u8; 24];
        rand::rngs::OsRng.fill_bytes(&mut bytes);
        let unusable = hex::encode(bytes);
        let hash = hash_password(&unusable).map_err(ApiError::from)?;
        let id = Uuid::now_v7();
        sqlx::query_as(
            "INSERT INTO users (id, org_id, email, password_hash, role, identity_type, display_name, avatar_url)              VALUES ($1, $2, $3, $4, 'member', 'oidc', $5, $6)              RETURNING id, org_id, email, role, identity_type, display_name, avatar_url",
        )
        .bind(id)
        .bind(org_id)
        .bind(email)
        .bind(hash)
        .bind(display_name)
        .bind(avatar_url)
        .fetch_one(self.pool)
        .await
        .map_err(Into::into)
    }

    /// Refreshes the OIDC-synced profile (name, avatar) after a login whose
    /// IdP claims differ from what is stored.
    pub async fn update_oidc_profile(
        &self,
        user_id: Uuid,
        display_name: Option<&str>,
        avatar_url: Option<&str>,
    ) -> Result<(), ApiError> {
        sqlx::query("UPDATE users SET display_name = $2, avatar_url = $3 WHERE id = $1")
            .bind(user_id)
            .bind(display_name)
            .bind(avatar_url)
            .execute(self.pool)
            .await
            .map_err(Into::into)
            .map(|_| ())
    }

    pub async fn authenticate(&self, email: &str, password: &str) -> Result<UserRow, ApiError> {
        let row: Option<AuthRow> = sqlx::query_as(
            "SELECT id, org_id, email, role, identity_type, password_hash, display_name, avatar_url FROM users WHERE email = $1",
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
            identity_type: auth.identity_type,
            display_name: auth.display_name,
            avatar_url: auth.avatar_url,
        })
    }

    pub async fn create_session(&self, user_id: Uuid) -> anyhow::Result<(Uuid, String)> {
        // session id is derived: we generate token first, use v7 id for bookkeeping
        let token = random_token();
        let id = Uuid::now_v7();
        let expires = Utc::now() + Duration::days(30);
        // Only the sha256 hash is stored (api keys and pairing codes do the
        // same): a database dump must not convert into session theft.
        sqlx::query("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)")
            .bind(sha256_hex(token.as_bytes()))
            .bind(user_id)
            .bind(expires)
            .execute(self.pool)
            .await?;
        Ok((id, token))
    }

    pub async fn validate_session(&self, token: &str) -> Result<UserRow, ApiError> {
        sqlx::query_as(
            "SELECT u.id, u.org_id, u.email, u.role, u.identity_type, u.display_name, u.avatar_url FROM sessions s \
             JOIN users u ON u.id = s.user_id \
             WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now()",
        )
        .bind(sha256_hex(token.as_bytes()))
        .fetch_optional(self.pool)
        .await?
        .ok_or_else(|| ApiError::unauthorized("invalid or expired session"))
    }

    pub async fn session_grant(
        &self,
        token: &str,
    ) -> Result<(String, chrono::DateTime<Utc>), ApiError> {
        let hash = sha256_hex(token.as_bytes());
        let expires = self.session_expiry(&hash).await?;
        Ok((hash, expires))
    }

    pub async fn session_expiry(&self, hash: &str) -> Result<chrono::DateTime<Utc>, ApiError> {
        sqlx::query_scalar("SELECT expires_at FROM sessions WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()")
            .bind(hash).fetch_optional(self.pool).await?
            .ok_or_else(|| ApiError::unauthorized("invalid or expired session"))
    }

    /// Refresh only a still-valid session. Revocation and expiry are final.
    pub async fn refresh_session(&self, token: &str) -> Result<(), ApiError> {
        let result = sqlx::query("UPDATE sessions SET expires_at = now() + interval '30 days' WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now()")
            .bind(sha256_hex(token.as_bytes())).execute(self.pool).await?;
        if result.rows_affected() == 0 {
            return Err(ApiError::unauthorized("invalid or expired session"));
        }
        Ok(())
    }

    pub async fn revoke_session(&self, token: &str) -> anyhow::Result<()> {
        sqlx::query("UPDATE sessions SET revoked_at = now() WHERE token_hash = $1")
            .bind(sha256_hex(token.as_bytes()))
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
    /// fields stay unchanged. The user must belong to the org. A password
    /// reset revokes the user's sessions — the old credentials must not
    /// keep working.
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
        let mut tx = self.pool.begin().await?;
        // All admin removals serialize on the same org row, including deletes.
        sqlx::query("SELECT id FROM orgs WHERE id = $1 FOR UPDATE")
            .bind(org_id)
            .fetch_one(&mut *tx)
            .await?;
        let target_role: Option<String> =
            sqlx::query_scalar("SELECT role FROM users WHERE id = $1 AND org_id = $2")
                .bind(user_id)
                .bind(org_id)
                .fetch_optional(&mut *tx)
                .await?;
        if target_role.as_deref() == Some("admin") && role.is_some_and(|r| r != "admin") {
            let others: i64 = sqlx::query_scalar(
                "SELECT count(*) FROM users WHERE org_id = $1 AND role = 'admin' AND id <> $2",
            )
            .bind(org_id)
            .bind(user_id)
            .fetch_one(&mut *tx)
            .await?;
            if others == 0 {
                return Err(ApiError::conflict(
                    "last_admin",
                    "cannot demote the last admin",
                ));
            }
        }
        let row = sqlx::query_as::<_, UserListRow>(
            "UPDATE users SET role = COALESCE($2::text, role), \
             password_hash = COALESCE($3::text, password_hash) \
             WHERE id = $1 AND org_id = $4 \
             RETURNING id, email, role, identity_type, created_at",
        )
        .bind(user_id)
        .bind(role)
        .bind(hash)
        .bind(org_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError::not_found("no such user"))?;
        if password.is_some() {
            sqlx::query("DELETE FROM pairing_tokens WHERE user_id = $1 AND used_at IS NULL")
                .bind(user_id)
                .execute(&mut *tx)
                .await?;
            sqlx::query("UPDATE api_keys SET revoked_at = now() WHERE (user_id = $1 OR created_by = $1) AND revoked_at IS NULL")
                .bind(user_id).execute(&mut *tx).await?;
            sqlx::query("UPDATE sessions SET revoked_at = now() WHERE user_id = $1")
                .bind(user_id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(row)
    }

    /// Deletes a user inside one transaction; refuses to remove the org's
    /// last admin. The org lock serializes all removals and demotions.
    pub async fn delete_user(&self, org_id: Uuid, user_id: Uuid) -> Result<(), ApiError> {
        let mut tx = self.pool.begin().await?;
        sqlx::query("SELECT id FROM orgs WHERE id = $1 FOR UPDATE")
            .bind(org_id)
            .fetch_one(&mut *tx)
            .await?;
        let target: Option<(String,)> =
            sqlx::query_as("SELECT role FROM users WHERE org_id = $1 AND id = $2 FOR UPDATE")
                .bind(org_id)
                .bind(user_id)
                .fetch_optional(&mut *tx)
                .await?;
        let Some((role,)) = target else {
            return Err(ApiError::not_found("no such user"));
        };
        let deleted = if role == "admin" {
            sqlx::query(
                "DELETE FROM users WHERE id = $1 AND (role <> 'admin' OR \
                 (SELECT COUNT(*) FROM users WHERE org_id = $2 AND role = 'admin' AND id <> $1) > 0)",
            )
            .bind(user_id)
            .bind(org_id)
            .execute(&mut *tx)
            .await?
            .rows_affected()
        } else {
            sqlx::query("DELETE FROM users WHERE id = $1")
                .bind(user_id)
                .execute(&mut *tx)
                .await?
                .rows_affected()
        };
        if deleted == 0 {
            return Err(ApiError::conflict(
                "last_admin",
                "cannot delete the last admin",
            ));
        }
        tx.commit().await?;
        Ok(())
    }

    /// Deletes expired sessions (rows outlive their TTL; unpruned they
    /// accumulate forever). Returns the number removed.
    pub async fn prune_expired_sessions(&self) -> anyhow::Result<u64> {
        let res = sqlx::query("DELETE FROM sessions WHERE expires_at <= now()")
            .execute(self.pool)
            .await?;
        Ok(res.rows_affected())
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
    async fn concurrent_admin_removals_preserve_one_admin() {
        for deletion in [false, true] {
            let db = Store::connect_test().await.unwrap();
            let store = &db.store;
            let org = uuid::Uuid::now_v7();
            sqlx::query("INSERT INTO orgs (id, name) VALUES ($1, 'test')")
                .bind(org)
                .execute(store.pool())
                .await
                .unwrap();
            let identity = store.identity();
            let a = identity
                .create_user(org, "a@test", "password1", "admin")
                .await
                .unwrap();
            let b = identity
                .create_user(org, "b@test", "password1", "admin")
                .await
                .unwrap();
            let (first, second) = tokio::join!(
                identity.update_user(org, a.id, Some("member"), None),
                async {
                    if deletion {
                        identity.delete_user(org, b.id).await
                    } else {
                        identity
                            .update_user(org, b.id, Some("member"), None)
                            .await
                            .map(|_| ())
                    }
                },
            );
            assert_ne!(
                first.is_ok(),
                second.is_ok(),
                "exactly one concurrent removal succeeds"
            );
            assert_eq!(
                identity
                    .list_users(org)
                    .await
                    .unwrap()
                    .iter()
                    .filter(|u| u.role == "admin")
                    .count(),
                1
            );
        }
    }

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

        // Only the hash is stored — the plaintext token is nowhere in the row.
        let stored: String =
            sqlx::query_scalar("SELECT token_hash FROM sessions WHERE user_id = $1")
                .bind(user.id)
                .fetch_one(db.store.pool())
                .await
                .unwrap();
        assert_ne!(stored, token);
        assert_eq!(stored.len(), 64);

        store.identity().revoke_session(&token).await.unwrap();
        assert!(store.identity().validate_session(&token).await.is_err());
    }

    /// A password reset through the admin path revokes existing sessions.
    #[tokio::test]
    async fn password_reset_revokes_sessions() {
        let db = Store::connect_test().await.unwrap();
        let store = &db.store;
        let org = uuid::Uuid::now_v7();
        sqlx::query("INSERT INTO orgs (id, name) VALUES ($1, 'test')")
            .bind(org)
            .execute(db.store.pool())
            .await
            .unwrap();
        let admin = store
            .identity()
            .create_user(org, "admin@example.org", "hunter226", "admin")
            .await
            .unwrap();
        let member = store
            .identity()
            .create_user(org, "member@example.org", "hunter226", "member")
            .await
            .unwrap();
        let (_sid, token) = store.identity().create_session(member.id).await.unwrap();
        assert!(store.identity().validate_session(&token).await.is_ok());

        store
            .identity()
            .update_user(org, member.id, None, Some("newpass99"))
            .await
            .unwrap();
        assert!(store.identity().validate_session(&token).await.is_err());

        // Role-only updates keep sessions alive.
        let (_sid2, token2) = store.identity().create_session(member.id).await.unwrap();
        store
            .identity()
            .update_user(org, member.id, Some("admin"), None)
            .await
            .unwrap();
        assert!(store.identity().validate_session(&token2).await.is_ok());
        let _ = admin;
    }
}
