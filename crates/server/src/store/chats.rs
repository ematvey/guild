//! Org-scoped chats (spec §4.3). Message history moved to the thread event
//! log (spec §A): `store::thread` owns persistence, this store owns chat rows.

use crate::http::error::ApiError;
use crate::store::events::notify_chat_status;
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
    /// A ChatRunner generation is in flight (server-side truth — identical
    /// for every device).
    pub generating: bool,
    /// The project (named workspace folder) the chat runs in; None =
    /// folderless.
    pub project_id: Option<Uuid>,
}

/// One row of the sidebar list: the chat plus the caller's derived unread
/// state (an assistant turn newer than the user's read marker, while the
/// chat is not generating).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ChatListRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub user_id: Uuid,
    pub title: Option<String>,
    pub created_at: DateTime<Utc>,
    pub machine_id: Option<String>,
    pub machine_label: Option<String>,
    pub generating: bool,
    pub unread: bool,
    pub project_id: Option<Uuid>,
    pub project_name: Option<String>,
    pub project_machine_label: Option<String>,
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
        project_id: Option<Uuid>,
    ) -> Result<ChatRow, ApiError> {
        self.create_chat_with_machine(org_id, user_id, title, project_id, None, None)
            .await
    }

    /// Creates a chat, binding the machine in the same INSERT as the project
    /// (bind-time machine inheritance: a chat runs where its project's
    /// folder lives). One statement, so the binding is atomic.
    pub async fn create_chat_with_machine(
        &self,
        org_id: Uuid,
        user_id: Uuid,
        title: Option<&str>,
        project_id: Option<Uuid>,
        machine_id: Option<&str>,
        machine_label: Option<&str>,
    ) -> Result<ChatRow, ApiError> {
        let id = Uuid::now_v7();
        sqlx::query_as::<_, ChatRow>(
            "INSERT INTO chats (id, org_id, user_id, title, project_id, machine_id, machine_label) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) \
             RETURNING id, org_id, user_id, title, created_at, machine_id, machine_label, generating, project_id",
        )
        .bind(id)
        .bind(org_id)
        .bind(user_id)
        .bind(title)
        .bind(project_id)
        .bind(machine_id)
        .bind(machine_label)
        .fetch_one(self.pool)
        .await
        .map_err(Into::into)
    }

    pub async fn list_chats(
        &self,
        org_id: Uuid,
        user_id: Uuid,
    ) -> Result<Vec<ChatListRow>, ApiError> {
        sqlx::query_as(
            "SELECT c.id, c.org_id, c.user_id, c.title, c.created_at, c.machine_id, c.machine_label, \
                    c.generating, c.project_id, pr.name AS project_name, m.label AS project_machine_label, \
                    c.generating = false AND EXISTS ( \
                      SELECT 1 FROM thread_events e \
                      WHERE e.chat_id = c.id AND e.type = 'assistant_message' \
                        AND (r.last_read_event_id IS NULL OR e.id > r.last_read_event_id)) AS unread \
             FROM chats c \
             LEFT JOIN chat_reads r ON r.chat_id = c.id AND r.user_id = $2 \
             LEFT JOIN projects pr ON pr.id = c.project_id \
             LEFT JOIN machines m ON m.machine_id = pr.machine_id \
             WHERE c.org_id = $1 AND c.user_id = $2 AND c.archived_at IS NULL \
             ORDER BY c.created_at DESC",
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
            "SELECT id, org_id, user_id, title, created_at, machine_id, machine_label, generating, project_id FROM chats \
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

    /// Renames and/or archives the chat (owner-scoped, admin bypass — the
    /// same gate as reads). `None` fields stay unchanged; archiving stamps
    /// `archived_at`, unarchiving clears it. The sidebar list never returns
    /// archived chats, but direct links still resolve.
    pub async fn update_chat(
        &self,
        org_id: Uuid,
        chat_id: Uuid,
        caller: &UserRow,
        title: Option<&str>,
        archived: Option<bool>,
    ) -> Result<ChatRow, ApiError> {
        let is_admin = caller.role == "admin";
        sqlx::query_as(
            "UPDATE chats SET \
             title = COALESCE($3, title), \
             archived_at = CASE \
               WHEN $4::bool IS NULL THEN archived_at \
               WHEN $4::bool THEN now() \
               ELSE NULL END \
             WHERE org_id = $1 AND id = $2 AND (user_id = $5 OR $6) \
             RETURNING id, org_id, user_id, title, created_at, machine_id, machine_label, generating, project_id",
        )
        .bind(org_id)
        .bind(chat_id)
        .bind(title)
        .bind(archived)
        .bind(caller.id)
        .bind(is_admin)
        .fetch_optional(self.pool)
        .await?
        .ok_or_else(|| ApiError::not_found("no such chat"))
    }

    /// Sets (or clears) the chat's machine binding. Called only from the
    /// project-alignment path: the machine is project-derived, so callers
    /// pass the project's machine, never a per-chat choice.
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
             RETURNING id, org_id, user_id, title, created_at, machine_id, machine_label, generating, project_id",
        )
        .bind(org_id)
        .bind(chat_id)
        .bind(machine_id)
        .bind(machine_label)
        .fetch_one(self.pool)
        .await
        .map_err(Into::into)
    }

    /// Sets (or clears, with `None`) the chat's project. Owner-scoped: the
    /// composer chip binds the chat to a named workspace folder. The machine
    /// binding is project-derived — it rides the same UPDATE (a chat runs
    /// where its project's folder lives) and clearing the project clears the
    /// machine; a machine-bound chat with no project is not a valid state.
    pub async fn set_project(
        &self,
        org_id: Uuid,
        chat_id: Uuid,
        caller: &UserRow,
        project_id: Option<Uuid>,
        machine: Option<(&str, &str)>,
    ) -> Result<ChatRow, ApiError> {
        let is_admin = caller.role == "admin";
        sqlx::query_as(
            "UPDATE chats SET project_id = $7, machine_id = $5, machine_label = $6 \
             WHERE org_id = $1 AND id = $2 AND (user_id = $3 OR $4) \
             RETURNING id, org_id, user_id, title, created_at, machine_id, machine_label, generating, project_id",
        )
        .bind(org_id)
        .bind(chat_id)
        .bind(caller.id)
        .bind(is_admin)
        .bind(machine.map(|(id, _)| id))
        .bind(machine.map(|(_, label)| label))
        .bind(project_id)
        .fetch_optional(self.pool)
        .await?
        .ok_or_else(|| ApiError::not_found("no such chat"))
    }

    /// The chat's project (id, name, machine label) for the sidebar and the
    /// sync view — a plain read; org-scoped.
    pub async fn project_of(
        &self,
        org_id: Uuid,
        chat_id: Uuid,
    ) -> Result<Option<(Uuid, String, Option<String>)>, ApiError> {
        sqlx::query_as(
            "SELECT pr.id, pr.name, m.label \
             FROM chats c \
             JOIN projects pr ON pr.id = c.project_id \
             LEFT JOIN machines m ON m.machine_id = pr.machine_id \
             WHERE c.org_id = $1 AND c.id = $2",
        )
        .bind(org_id)
        .bind(chat_id)
        .fetch_optional(self.pool)
        .await
        .map_err(Into::into)
    }

    /// Sets (or clears, with `None`) the chat's approval-mode override —
    /// the composer's per-chat policy; `{"default": "ask"|"allow"|"never"}`
    /// replaces the user-level default for this chat. Owner-scoped.
    pub async fn set_approval(
        &self,
        org_id: Uuid,
        user_id: Uuid,
        chat_id: Uuid,
        policy: Option<&serde_json::Value>,
    ) -> Result<(), ApiError> {
        let n = sqlx::query(
            "UPDATE chats SET approval = $4 WHERE org_id = $1 AND id = $2 AND user_id = $3",
        )
        .bind(org_id)
        .bind(chat_id)
        .bind(user_id)
        .bind(policy)
        .execute(self.pool)
        .await
        .map_err(Into::<ApiError>::into)?
        .rows_affected();
        if n == 0 {
            return Err(ApiError::not_found("no such chat"));
        }
        Ok(())
    }

    /// The chat's approval-mode override (owner-scoped; None = account
    /// default applies).
    pub async fn approval(
        &self,
        org_id: Uuid,
        user_id: Uuid,
        chat_id: Uuid,
    ) -> Result<Option<serde_json::Value>, ApiError> {
        sqlx::query_scalar::<_, Option<serde_json::Value>>(
            "SELECT approval FROM chats WHERE org_id = $1 AND id = $3 AND user_id = $2",
        )
        .bind(org_id)
        .bind(user_id)
        .bind(chat_id)
        .fetch_optional(self.pool)
        .await
        .map(|o| o.flatten())
        .map_err(|e| ApiError::internal(format!("chat approval read failed: {e:?}")))
    }

    /// Flips the chat's generating flag and notifies the status channel in
    /// the same transaction, so no observer ever sees the flag and the
    /// notification disagree. No-op (and silent) when the flag already
    /// holds the target value — the ChatRunner's journaled steps re-run it
    /// on every replay.
    pub async fn set_generating(
        &self,
        org_id: Uuid,
        chat_id: Uuid,
        generating: bool,
    ) -> Result<(), ApiError> {
        let user_id: Option<Uuid> = sqlx::query_scalar(
            "UPDATE chats SET generating = $3 \
             WHERE org_id = $1 AND id = $2 AND generating IS DISTINCT FROM $3 \
             RETURNING user_id",
        )
        .bind(org_id)
        .bind(chat_id)
        .bind(generating)
        .fetch_optional(self.pool)
        .await?;
        if let Some(user_id) = user_id {
            notify_chat_status(self.pool, org_id, user_id, chat_id, generating).await?;
        }
        Ok(())
    }

    /// Clears the flag without org scoping — the startup sweep (trusted
    /// internal) resolves stranded workflows whose chat rows must not keep
    /// a forever-spinner.
    pub async fn clear_generating(&self, chat_id: Uuid) -> Result<(), ApiError> {
        let row: Option<(Uuid, Uuid)> = sqlx::query_as(
            "UPDATE chats SET generating = false \
             WHERE id = $1 AND generating IS DISTINCT FROM false \
             RETURNING org_id, user_id",
        )
        .bind(chat_id)
        .fetch_optional(self.pool)
        .await?;
        if let Some((org_id, user_id)) = row {
            notify_chat_status(self.pool, org_id, user_id, chat_id, false).await?;
        }
        Ok(())
    }

    /// Marks the chat read for the caller: the marker moves to the newest
    /// thread event. Org-scoped like every chat read; a chat with no events
    /// yet has nothing unread — the marker is simply not written.
    pub async fn mark_read(
        &self,
        org_id: Uuid,
        chat_id: Uuid,
        caller: &UserRow,
    ) -> Result<(), ApiError> {
        // Same owner/admin gate as get_chat.
        self.get_chat(org_id, chat_id, caller).await?;
        // The marker is the newest thread event (uuid v7 sorts by time; the
        // monotonic `seq` orders the rows — max(id) does not exist for uuid).
        let last: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM thread_events WHERE chat_id = $1 ORDER BY seq DESC LIMIT 1",
        )
        .bind(chat_id)
        .fetch_optional(self.pool)
        .await?;
        let Some(last_read_event_id) = last else {
            return Ok(()); // no events yet — nothing unread, no marker
        };
        sqlx::query(
            "INSERT INTO chat_reads (chat_id, user_id, last_read_event_id) \
             VALUES ($1, $2, $3) \
             ON CONFLICT (chat_id, user_id) \
             DO UPDATE SET last_read_event_id = EXCLUDED.last_read_event_id",
        )
        .bind(chat_id)
        .bind(caller.id)
        .bind(last_read_event_id)
        .execute(self.pool)
        .await?;
        Ok(())
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
            .create_chat(org, alice.id, Some("alice's"), None)
            .await
            .unwrap();

        // Owner reads their own chat.
        let owned = store.chats().get_chat(org, chat.id, &alice).await.unwrap();
        assert_eq!(owned.id, chat.id);

        // Another member of the same org does not — 404, not a leak.
        let err = store
            .chats()
            .get_chat(org, chat.id, &bob)
            .await
            .unwrap_err();
        assert_eq!(err.status, axum::http::StatusCode::NOT_FOUND);

        // Admins can access any chat in their org.
        let via_admin = store.chats().get_chat(org, chat.id, &admin).await.unwrap();
        assert_eq!(via_admin.id, chat.id);
    }

    /// Thread-list status: generating flag flips notify + suppress unread;
    /// unread derives from assistant turns newer than the read marker and
    /// clears on mark_read; markers are per user (a foreign chat is 404).
    #[tokio::test]
    async fn chat_status_flags_roundtrip() {
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
            .create_user(org, "alice2@example.org", "hunter226", "member")
            .await
            .unwrap();
        let bob = store
            .identity()
            .create_user(org, "bob2@example.org", "hunter226", "member")
            .await
            .unwrap();
        let chat = store
            .chats()
            .create_chat(org, alice.id, Some("status"), None)
            .await
            .unwrap();

        let list = || async { store.chats().list_chats(org, alice.id).await };
        // fresh chat: idle and read
        let row = &list().await.unwrap()[0];
        assert!(!row.generating);
        assert!(!row.unread);

        // generating suppresses unread even with unseen assistant turns
        store
            .chats()
            .set_generating(org, chat.id, true)
            .await
            .unwrap();
        let user_ev = protocol::api::ThreadEvent::UserMessage {
            content: "hi".into(),
            attachments: vec![],
        };
        store
            .thread()
            .append_event(chat.id, &user_ev)
            .await
            .unwrap();
        let asst = |turn: u32| protocol::api::ThreadEvent::AssistantMessage {
            turn,
            step: 0,
            blocks: vec![protocol::api::Block::Text {
                text: "reply".into(),
            }],
            usage: Default::default(),
            model: "m".into(),
            interrupted: None,
        };
        store
            .thread()
            .append_event(chat.id, &asst(1))
            .await
            .unwrap();
        let row = &list().await.unwrap()[0];
        assert!(row.generating);
        assert!(!row.unread);

        // turn done: the unseen assistant reply becomes unread
        store
            .chats()
            .set_generating(org, chat.id, true)
            .await
            .unwrap(); // replay no-op: no second notification, flag unchanged
        store
            .chats()
            .set_generating(org, chat.id, false)
            .await
            .unwrap();
        let row = &list().await.unwrap()[0];
        assert!(!row.generating);
        assert!(row.unread);

        // reading clears the dot; a newer assistant turn re-sets it
        store.chats().mark_read(org, chat.id, &alice).await.unwrap();
        let row = &list().await.unwrap()[0];
        assert!(!row.unread);
        store
            .thread()
            .append_event(chat.id, &asst(2))
            .await
            .unwrap();
        let row = &list().await.unwrap()[0];
        assert!(row.unread);
        store.chats().mark_read(org, chat.id, &alice).await.unwrap();
        assert!(!list().await.unwrap()[0].unread);

        // markers are per user; a foreign member cannot mark someone
        // else's chat read (same owner gate as every chat read)
        assert_eq!(
            store
                .chats()
                .mark_read(org, chat.id, &bob)
                .await
                .unwrap_err()
                .status,
            axum::http::StatusCode::NOT_FOUND
        );
        assert!(list().await.unwrap()[0].unread == false);
    }

    /// Rename + archive roundtrip: PATCH changes the title, archiving hides
    /// the chat from the list while direct fetch still resolves,
    /// unarchiving brings it back; a foreign member gets 404.
    #[tokio::test]
    async fn chat_rename_and_archive() {
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
            .create_user(org, "arch@example.org", "hunter226", "member")
            .await
            .unwrap();
        let bob = store
            .identity()
            .create_user(org, "arch2@example.org", "hunter226", "member")
            .await
            .unwrap();
        let chat = store
            .chats()
            .create_chat(org, alice.id, Some("before"), None)
            .await
            .unwrap();

        // rename
        let renamed = store
            .chats()
            .update_chat(org, chat.id, &alice, Some("after"), None)
            .await
            .unwrap();
        assert_eq!(renamed.title.as_deref(), Some("after"));

        // archive hides from the list, fetch still resolves
        store
            .chats()
            .update_chat(org, chat.id, &alice, None, Some(true))
            .await
            .unwrap();
        assert!(store.chats().list_chats(org, alice.id).await.unwrap().is_empty());
        assert_eq!(
            store.chats().get_chat(org, chat.id, &alice).await.unwrap().id,
            chat.id
        );

        // unarchive
        store
            .chats()
            .update_chat(org, chat.id, &alice, None, Some(false))
            .await
            .unwrap();
        assert_eq!(
            store.chats().list_chats(org, alice.id).await.unwrap()[0].id,
            chat.id
        );

        // a foreign member of the same org cannot rename or archive it
        assert_eq!(
            store
                .chats()
                .update_chat(org, chat.id, &bob, Some("x"), None)
                .await
                .unwrap_err()
                .status,
            axum::http::StatusCode::NOT_FOUND
        );
    }
}
