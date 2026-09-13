//! Org-scoped chats (spec §4.3). Message history moved to the thread event
//! log (spec §A): `store::thread` owns persistence, this store owns chat rows.

use crate::http::error::ApiError;
use crate::store::identity::UserRow;
use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ChatRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub user_id: Uuid,
    pub title: Option<String>,
    pub created_at: DateTime<Utc>,
    /// Bound executor machine (machine tools run only there).
    pub machine_id: Option<String>,
    pub machine_label: Option<String>,
}

pub struct ChatStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

impl<'a> ChatStore<'a> {
    pub async fn create_chat(
        &self,
        org_id: Uuid,
        user_id: Uuid,
        title: Option<&str>,
    ) -> Result<ChatRow, ApiError> {
        let id = Uuid::now_v7();
        sqlx::query_as::<_, ChatRow>(
            "INSERT INTO chats (id, org_id, user_id, title) VALUES ($1, $2, $3, $4) \
             RETURNING id, org_id, user_id, title, created_at, machine_id, machine_label",
        )
        .bind(id)
        .bind(org_id)
        .bind(user_id)
        .bind(title)
        .fetch_one(self.pool)
        .await
        .map_err(Into::into)
    }

    pub async fn list_chats(&self, org_id: Uuid, user_id: Uuid) -> Result<Vec<ChatRow>, ApiError> {
        sqlx::query_as(
            "SELECT id, org_id, user_id, title, created_at, machine_id, machine_label FROM chats \
             WHERE org_id = $1 AND user_id = $2 ORDER BY created_at DESC",
        )
        .bind(org_id)
        .bind(user_id)
        .fetch_all(self.pool)
        .await
        .map_err(Into::into)
    }

    /// Fetches one chat the caller owns. Admins may access any chat in the
    /// org; everyone else only their own — org scoping alone would let a
    /// member read another member's thread, forge its events, rebind its
    /// machine, or spend the org's tokens through it.
    pub async fn get_chat(
        &self,
        org_id: Uuid,
        chat_id: Uuid,
        caller: &UserRow,
    ) -> Result<ChatRow, ApiError> {
        let is_admin = caller.role == "admin";
        sqlx::query_as(
            "SELECT id, org_id, user_id, title, created_at, machine_id, machine_label FROM chats \
             WHERE org_id = $1 AND id = $2 AND (user_id = $3 OR $4)",
        )
        .bind(org_id)
        .bind(chat_id)
        .bind(caller.id)
        .bind(is_admin)
        .fetch_optional(self.pool)
        .await?
        .ok_or_else(|| ApiError::not_found("no such chat"))
    }

    /// Binds (or unbinds, with `None`s) a chat to an executor machine.
    pub async fn set_machine(
        &self,
        org_id: Uuid,
        chat_id: Uuid,
        machine_id: Option<&str>,
        machine_label: Option<&str>,
    ) -> Result<ChatRow, ApiError> {
        sqlx::query_as(
            "UPDATE chats SET machine_id = $3, machine_label = $4 \
             WHERE org_id = $1 AND id = $2 \
             RETURNING id, org_id, user_id, title, created_at, machine_id, machine_label",
        )
        .bind(org_id)
        .bind(chat_id)
        .bind(machine_id)
        .bind(machine_label)
        .fetch_one(self.pool)
        .await
        .map_err(Into::into)
    }
}

#[cfg(all(test, feature = "test-support"))]
mod tests {
    use crate::store::Store;

    /// Member A must not read member B's chat; admins pass.
    #[tokio::test]
    async fn chat_access_is_owner_scoped_with_admin_bypass() {
        let db = Store::connect_test().await.unwrap();
        let store = &db.store;
        let org = uuid::Uuid::now_v7();
        sqlx::query("INSERT INTO orgs (id, name) VALUES ($1, 'test')")
            .bind(org)
            .execute(store.pool())
            .await
            .unwrap();
        let alice = store
            .identity()
            .create_user(org, "alice@example.org", "hunter226", "member")
            .await
            .unwrap();
        let bob = store
            .identity()
            .create_user(org, "bob@example.org", "hunter226", "member")
            .await
            .unwrap();
        let admin = store
            .identity()
            .create_user(org, "root@example.org", "hunter226", "admin")
            .await
            .unwrap();
        let chat = store
            .chats()
            .create_chat(org, alice.id, Some("alice's"))
            .await
            .unwrap();

        // Owner reads their own chat.
        let owned = store.chats().get_chat(org, chat.id, &alice).await.unwrap();
        assert_eq!(owned.id, chat.id);

        // Another member of the same org does not — 404, not a leak.
        let err = store.chats().get_chat(org, chat.id, &bob).await.unwrap_err();
        assert_eq!(err.status, axum::http::StatusCode::NOT_FOUND);

        // Admins can access any chat in their org.
        let via_admin = store.chats().get_chat(org, chat.id, &admin).await.unwrap();
        assert_eq!(via_admin.id, chat.id);
    }
}
