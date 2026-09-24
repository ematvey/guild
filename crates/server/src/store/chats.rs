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

    /// The insert on a caller-supplied executor (the create handler runs it
    /// inside its own transaction, uncommitted until the workspace is ready).
    pub async fn create_chat_on(
        &self,
        ex: impl sqlx::PgExecutor<'_>,
        org_id: Uuid,
        user_id: Uuid,
        title: Option<&str>,
        project_id: Option<Uuid>,
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
        .bind(None::<String>)
        .bind(None::<String>)
        .fetch_one(ex)
        .await
        .map_err(Into::into)
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

    /// Creates a chat bound to its project's machine. The project row is
    /// locked and its machine binding read inside the same transaction as
    /// the INSERT, so a concurrent re-pair adoption can never slip a retired
    /// machine id between the read and the write: adoption re-keys projects
    /// and chats under the same serialization the lock provides.
    pub async fn create_chat_for_project(
        &self,
        org_id: Uuid,
        user_id: Uuid,
        title: Option<&str>,
        project_id: Uuid,
    ) -> Result<ChatRow, ApiError> {
        let mut tx = self.pool.begin().await?;
        let binding: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT p.machine_id, coalesce(m.label, p.machine_id) \
             FROM projects p \
             LEFT JOIN machines m ON m.machine_id = p.machine_id \
             WHERE p.id = $1 AND p.org_id = $2 AND p.user_id = $3 \
             FOR UPDATE OF p",
        )
        .bind(project_id)
        .bind(org_id)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some((machine_id, machine_label)) = binding else {
            return Err(ApiError::not_found("no such project"));
        };
        let id = Uuid::now_v7();
        let chat = sqlx::query_as::<_, ChatRow>(
            "INSERT INTO chats (id, org_id, user_id, title, project_id, machine_id, machine_label) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) \
             RETURNING id, org_id, user_id, title, created_at, machine_id, machine_label, generating, project_id",
        )
        .bind(id)
        .bind(org_id)
        .bind(user_id)
        .bind(title)
        .bind(project_id)
        .bind(&machine_id)
        .bind(&machine_label)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(chat)
    }

    /// Shared SELECT/JOIN for the active-chat lists (full and paged): the
    /// unread projection reads the caller's read watermark, the project and
    /// machine joins feed the sidebar's grouping.
    const LIST_SELECT: &'static str =
        "SELECT c.id, c.org_id, c.user_id, c.title, c.created_at, c.machine_id, c.machine_label, \
                    c.generating, c.project_id, pr.name AS project_name, m.label AS project_machine_label, \
                    c.generating = false AND EXISTS ( \
                      SELECT 1 FROM thread_events e \
                      WHERE e.chat_id = c.id AND e.type = 'assistant_message' \
                        AND (r.last_read_event_id IS NULL OR e.id > r.last_read_event_id)) AS unread \
             FROM chats c \
             LEFT JOIN chat_reads r ON r.chat_id = c.id AND r.user_id = $2 \
             LEFT JOIN projects pr ON pr.id = c.project_id \
             LEFT JOIN machines m ON m.machine_id = pr.machine_id";

    pub async fn list_chats(
        &self,
        org_id: Uuid,
        user_id: Uuid,
    ) -> Result<Vec<ChatListRow>, ApiError> {
        sqlx::query_as(&format!(
            "{} WHERE c.org_id = $1 AND c.user_id = $2 AND c.archived_at IS NULL \
             ORDER BY c.created_at DESC, c.id DESC",
            Self::LIST_SELECT
        ))
        .bind(org_id)
        .bind(user_id)
        .fetch_all(self.pool)
        .await
        .map_err(Into::into)
    }

    /// Newest page of the caller's active chats, keyset-paginated on
    /// `(created_at, id)` — the same `(ORDER BY … DESC)` pair, so a page
    /// boundary is a pure cursor, not an offset (rows shift as chats are
    /// created). Same unread projection as `list_chats` (the sidebar's dot
    /// must be right on the first page too). The extra limit+1th row
    /// becomes `has_more`. The `before` cursor pair comes from the
    /// previous page's last row.
    pub async fn list_chats_page(
        &self,
        org_id: Uuid,
        user_id: Uuid,
        limit: i64,
        before: Option<(DateTime<Utc>, Uuid)>,
    ) -> Result<(Vec<ChatListRow>, bool), ApiError> {
        let (before_created_at, before_id) = match before {
            Some((ts, id)) => (Some(ts), Some(id)),
            None => (None, None),
        };
        let mut rows: Vec<ChatListRow> = sqlx::query_as(&format!(
            "{} WHERE c.org_id = $1 AND c.user_id = $2 AND c.archived_at IS NULL \
               AND ($3::timestamptz IS NULL OR (c.created_at, c.id) < ($3::timestamptz, $4::uuid)) \
             ORDER BY c.created_at DESC, c.id DESC LIMIT $5",
            Self::LIST_SELECT
        ))
        .bind(org_id)
        .bind(user_id)
        .bind(before_created_at)
        .bind(before_id)
        .bind(limit + 1)
        .fetch_all(self.pool)
        .await
        .map_err(ApiError::from)?;
        let has_more = rows.len() as i64 > limit;
        rows.truncate(limit as usize);
        Ok((rows, has_more))
    }

    /// Lists the caller's archived chats (the sidebar's Archived section);
    /// the mirror image of `list_chats`' `archived_at IS NULL` filter.
    pub async fn list_archived_chats(
        &self,
        org_id: Uuid,
        user_id: Uuid,
    ) -> Result<Vec<ChatListRow>, ApiError> {
        sqlx::query_as(
            "SELECT c.id, c.org_id, c.user_id, c.title, c.created_at, c.machine_id, c.machine_label, \
                    c.generating, c.project_id, pr.name AS project_name, m.label AS project_machine_label, \
                    false AS unread \
             FROM chats c \
             LEFT JOIN projects pr ON pr.id = c.project_id \
             LEFT JOIN machines m ON m.machine_id = pr.machine_id \
             WHERE c.org_id = $1 AND c.user_id = $2 AND c.archived_at IS NOT NULL \
             ORDER BY c.created_at DESC, c.id DESC",
        )
        .bind(org_id)
        .bind(user_id)
        .fetch_all(self.pool)
        .await
        .map_err(Into::into)
    }

    /// Newest page of the caller's archived chats — same keyset contract as
    /// `list_chats_page`, `archived_at IS NOT NULL`.
    pub async fn list_archived_chats_page(
        &self,
        org_id: Uuid,
        user_id: Uuid,
        limit: i64,
        before: Option<(DateTime<Utc>, Uuid)>,
    ) -> Result<(Vec<ChatListRow>, bool), ApiError> {
        let (before_created_at, before_id) = match before {
            Some((ts, id)) => (Some(ts), Some(id)),
            None => (None, None),
        };
        let mut rows: Vec<ChatListRow> = sqlx::query_as(
            "SELECT c.id, c.org_id, c.user_id, c.title, c.created_at, c.machine_id, c.machine_label, \
                    c.generating, c.project_id, pr.name AS project_name, m.label AS project_machine_label, \
                    false AS unread \
             FROM chats c \
             LEFT JOIN projects pr ON pr.id = c.project_id \
             LEFT JOIN machines m ON m.machine_id = pr.machine_id \
             WHERE c.org_id = $1 AND c.user_id = $2 AND c.archived_at IS NOT NULL \
               AND ($3::timestamptz IS NULL OR (c.created_at, c.id) < ($3::timestamptz, $4::uuid)) \
             ORDER BY c.created_at DESC, c.id DESC LIMIT $5",
        )
        .bind(org_id)
        .bind(user_id)
        .bind(before_created_at)
        .bind(before_id)
        .bind(limit + 1)
        .fetch_all(self.pool)
        .await
        .map_err(ApiError::from)?;
        let has_more = rows.len() as i64 > limit;
        rows.truncate(limit as usize);
        Ok((rows, has_more))
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

    /// Org-scope check for machine-reply paths: proves the chat lives in the
    /// caller's org without granting owner-level visibility (an org-shared
    /// machine returns results for a chat it does not own).
    pub async fn org_contains_chat(&self, org_id: Uuid, chat_id: Uuid) -> Result<(), ApiError> {
        let known: Option<(Uuid,)> =
            sqlx::query_as("SELECT id FROM chats WHERE org_id = $1 AND id = $2")
                .bind(org_id)
                .bind(chat_id)
                .fetch_optional(self.pool)
                .await?;
        if known.is_none() {
            return Err(ApiError::not_found("no such chat"));
        }
        Ok(())
    }

    /// Read access for machine-originated fetches (thread rebuild and tool
    /// artifact spill prefetch/first-touch): the caller acts as one of its
    /// machines, and the chat's executor machine — the project row's binding
    /// when set, else the chat's own binding — may read the chat it runs.
    /// Ordinary member reads keep the owner/admin gate of `get_chat`.
    pub async fn readable_by_executor(
        &self,
        org_id: Uuid,
        chat_id: Uuid,
        caller: &UserRow,
    ) -> Result<(), ApiError> {
        let machine: Option<(Option<String>,)> = sqlx::query_as(
            "SELECT COALESCE(pr.machine_id, c.machine_id) FROM chats c \
             LEFT JOIN projects pr ON pr.id = c.project_id \
             WHERE c.org_id = $1 AND c.id = $2",
        )
        .bind(org_id)
        .bind(chat_id)
        .fetch_optional(self.pool)
        .await?;
        if let Some((Some(machine_id),)) = machine {
            let machines = crate::store::machines::MachineStore { pool: self.pool };
            match machines.owner_of(&machine_id).await {
                Ok(Some((owner_id, machine_org)))
                    if owner_id == caller.id && machine_org == org_id =>
                {
                    return Ok(());
                }
                Ok(_) => {}
                Err(error) => {
                    tracing::warn!(?error, %machine_id, "machine read gate failed");
                }
            }
        }
        self.get_chat(org_id, chat_id, caller).await.map(|_| ())
    }

    /// Renames and/or archives the chat (owner-scoped, admin bypass — the
    /// same gate as reads). `None` fields stay unchanged; archiving stamps
    /// `archived_at` and settles every waiting command as cancelled in the
    /// same transaction — successors of a stopped turn must not run in an
    /// archived chat. Unarchiving clears the flag without restoring them.
    /// The sidebar list never returns archived chats, but direct links
    /// still resolve.
    ///
    /// The chats row lock is taken in its own statement BEFORE the settle
    /// runs, so the ordering serializes against in-flight turn acceptance
    /// (which locks the same row): the settle's snapshot is taken after any
    /// concurrent send committed and sees its command; a send that starts
    /// later blocks on the lock and then observes `archived_at`. A shared
    /// statement snapshot would miss a command inserted while the archive
    /// waited on the lock and strand it undispatched in the archived chat.
    pub async fn update_chat(
        &self,
        org_id: Uuid,
        chat_id: Uuid,
        caller: &UserRow,
        title: Option<&str>,
        archived: Option<bool>,
    ) -> Result<ChatRow, ApiError> {
        let is_admin = caller.role == "admin";
        let mut tx = self.pool.begin().await?;
        let locked: Option<(Uuid,)> = sqlx::query_as(
            "SELECT id FROM chats WHERE org_id = $1 AND id = $2 AND (user_id = $3 OR $4) FOR UPDATE",
        )
        .bind(org_id)
        .bind(chat_id)
        .bind(caller.id)
        .bind(is_admin)
        .fetch_optional(&mut *tx)
        .await?;
        if locked.is_none() {
            return Err(ApiError::not_found("no such chat"));
        }
        let row: ChatRow = sqlx::query_as(
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
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError::not_found("no such chat"))?;
        if archived == Some(true) {
            sqlx::query(
                "UPDATE turn_commands SET status = 'cancelled', finished_at = now() \
                 WHERE chat_id = $1 AND finished_at IS NULL AND status IN ('pending','submitted')",
            )
            .bind(chat_id)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(row)
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
        let mut tx = self.pool.begin().await?;
        if let Some(mid) = machine_id {
            // The registry row is locked inside the write tx
            // (adoption-compatible order): a re-keyed id no longer
            // resolves under its old name, so a stale cached machine can
            // never be reinstated over an adopted binding — the write
            // either sees the row adoption left in place, or fails closed.
            let known: Option<String> = sqlx::query_scalar(
                "SELECT machine_id FROM machines WHERE machine_id = $1 AND org_id = $2 FOR UPDATE",
            )
            .bind(mid)
            .bind(org_id)
            .fetch_optional(&mut *tx)
            .await?;
            if known.is_none() {
                return Err(ApiError::bad_request("unknown machine"));
            }
        }
        let chat: ChatRow = sqlx::query_as(
            "UPDATE chats SET machine_id = $3, machine_label = $4 \
             WHERE org_id = $1 AND id = $2 \
             RETURNING id, org_id, user_id, title, created_at, machine_id, machine_label, generating, project_id",
        )
        .bind(org_id)
        .bind(chat_id)
        .bind(machine_id)
        .bind(machine_label)
        .fetch_one(&mut *tx)
        .await
        .map_err(ApiError::from)?;
        tx.commit().await?;
        Ok(chat)
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
    ) -> Result<ChatRow, ApiError> {
        let is_admin = caller.role == "admin";
        let mut tx = self.pool.begin().await?;
        // Machine binding is project-derived and read INSIDE the write tx
        // with the project row locked: adoption re-keys the binding
        // atomically, so a split read/write could reinstate the
        // pre-adoption machine id over the adopted one. A requested project
        // the caller doesn't own (or that doesn't exist) is not found; only
        // `project_id: None` unbinds.
        let machine: Option<(Option<String>, Option<String>)> = match project_id {
            Some(pid) => Some(
                sqlx::query_as(
                    "SELECT p.machine_id, m.label FROM projects p \
                 LEFT JOIN machines m ON m.machine_id = p.machine_id \
                 WHERE p.org_id = $1 AND p.id = $2 AND p.user_id = $3 FOR UPDATE OF p",
                )
                .bind(org_id)
                .bind(pid)
                .bind(caller.id)
                .fetch_optional(&mut *tx)
                .await?
                .ok_or_else(|| ApiError::not_found("no such project"))?,
            ),
            None => None,
        };
        let chat: ChatRow = sqlx::query_as(
            "UPDATE chats SET project_id = $7, machine_id = $5, machine_label = $6 \
             WHERE org_id = $1 AND id = $2 AND (user_id = $3 OR $4) \
             RETURNING id, org_id, user_id, title, created_at, machine_id, machine_label, generating, project_id",
        )
        .bind(org_id)
        .bind(chat_id)
        .bind(caller.id)
        .bind(is_admin)
        .bind(machine.as_ref().and_then(|(id, _)| id.clone()))
        .bind(machine.as_ref().and_then(|(_, label)| label.clone()))
        .bind(project_id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| ApiError::not_found("no such chat"))?;
        tx.commit().await?;
        Ok(chat)
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
        assert!(!list().await.unwrap()[0].unread);
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
        assert!(store
            .chats()
            .list_chats(org, alice.id)
            .await
            .unwrap()
            .is_empty());
        assert_eq!(
            store
                .chats()
                .get_chat(org, chat.id, &alice)
                .await
                .unwrap()
                .id,
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
