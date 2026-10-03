//! Org-scoped projects (spec §1): a named folder bound to a machine. Chats
//! attach to a project (`chats.project_id`) and the ChatRunner resolves the
//! workspace folder from it. Strictly owner-scoped: every operation filters
//! on `user_id`, with no admin bypass — a user, including an admin, sees and
//! touches only their own projects.

use crate::http::error::ApiError;
use chrono::{DateTime, Utc};
use uuid::Uuid;

/// One project row joined with its machine's registry label (the machines
/// table is the durable label source; the live hub refines it at render time).
#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ProjectRow {
    pub id: Uuid,
    pub org_id: Uuid,
    pub user_id: Uuid,
    pub name: String,
    /// Windows path; UNC (`\\wsl.localhost\…`) for a WSL distro folder.
    pub folder: String,
    pub machine_id: String,
    pub created_at: DateTime<Utc>,
    pub machine_label: Option<String>,
}

pub struct ProjectStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

const ROW_COLUMNS: &str =
    "p.id, p.org_id, p.user_id, p.name, p.folder, p.machine_id, p.created_at, \
     coalesce(m.label, p.machine_id) AS machine_label";

const ROW_FROM: &str = "projects p LEFT JOIN machines m ON m.machine_id = p.machine_id";

impl<'a> ProjectStore<'a> {
    /// Locks the machine's registry row and proves bindability inside the
    /// caller's transaction: a fingerprint adoption (which locks the same row
    /// before re-keying) can never commit between this check and the binding
    /// write, so a retired id cannot be reinstalled by a paused writer.
    async fn lock_bindable_machine(
        tx: &mut sqlx::PgConnection,
        machine_id: &str,
        user_id: Uuid,
        org_id: Uuid,
    ) -> Result<(), ApiError> {
        let known: Option<String> = sqlx::query_scalar(
            "SELECT machine_id FROM machines \
             WHERE machine_id = $1 AND (user_id = $2 OR org_id = $3) FOR UPDATE",
        )
        .bind(machine_id)
        .bind(user_id)
        .bind(org_id)
        .fetch_optional(&mut *tx)
        .await?;
        if known.is_none() {
            return Err(ApiError::bad_request("unknown machine"));
        }
        Ok(())
    }

    /// Creates a project. Names are display labels derived from the chosen
    /// folder — duplicate names are allowed. The machine must be registered
    /// to the caller or their org; the check and the INSERT share one
    /// transaction with the registry row locked, so adoption cannot commit
    /// between them. One live project per (machine, folder): the unique
    /// index is the guard (it covers a cross-device race and a second user
    /// of a shared machine); a violation is a 409. Archived projects step
    /// aside and free the folder.
    pub async fn create(
        &self,
        org_id: Uuid,
        user_id: Uuid,
        name: &str,
        folder: &str,
        machine_id: &str,
    ) -> Result<ProjectRow, ApiError> {
        let id = Uuid::now_v7();
        let mut tx = self.pool.begin().await?;
        Self::lock_bindable_machine(&mut tx, machine_id, user_id, org_id).await?;
        match sqlx::query(
            "INSERT INTO projects (id, org_id, user_id, name, folder, machine_id) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(id)
        .bind(org_id)
        .bind(user_id)
        .bind(name)
        .bind(folder)
        .bind(machine_id)
        .execute(&mut *tx)
        .await
        {
            Ok(result) => debug_assert_eq!(result.rows_affected(), 1),
            Err(sqlx::Error::Database(db)) if db.is_unique_violation() => {
                return Err(ApiError::conflict(
                    "folder_taken",
                    "a project for this folder already exists on this machine",
                ));
            }
            Err(e) => return Err(ApiError::from(e)),
        }
        tx.commit().await?;
        self.fetch_by_id(id).await
    }

    /// Lists the caller's projects — owner-only, admins included.
    pub async fn list(&self, org_id: Uuid, user_id: Uuid) -> Result<Vec<ProjectRow>, ApiError> {
        sqlx::query_as(&format!(
            "SELECT {ROW_COLUMNS} FROM {ROW_FROM} \
             WHERE p.org_id = $1 AND p.user_id = $2 AND p.archived_at IS NULL \
             ORDER BY p.created_at DESC"
        ))
        .bind(org_id)
        .bind(user_id)
        .fetch_all(self.pool)
        .await
        .map_err(Into::into)
    }

    /// Fetches one project the caller owns — owner-only, admins included.
    pub async fn get(
        &self,
        org_id: Uuid,
        project_id: Uuid,
        user_id: Uuid,
    ) -> Result<ProjectRow, ApiError> {
        sqlx::query_as(&format!(
            "SELECT {ROW_COLUMNS} FROM {ROW_FROM} \
             WHERE p.org_id = $1 AND p.id = $2 AND p.user_id = $3"
        ))
        .bind(org_id)
        .bind(project_id)
        .bind(user_id)
        .fetch_optional(self.pool)
        .await?
        .ok_or_else(|| ApiError::not_found("no such project"))
    }

    /// Updates the editable fields (`None` = keep). Duplicate names are
    /// allowed; moving the project onto a machine+folder another live
    /// project holds is a 409. `archived` soft-hides: archived projects drop
    /// out of `list` but direct fetches still resolve, and archiving frees
    /// the folder for a new project.
    // This scoped update accepts independent optional project fields.
    #[allow(clippy::too_many_arguments)]
    pub async fn update(
        &self,
        org_id: Uuid,
        project_id: Uuid,
        user_id: Uuid,
        name: Option<&str>,
        folder: Option<&str>,
        machine_id: Option<&str>,
        archived: Option<bool>,
    ) -> Result<ProjectRow, ApiError> {
        let mut tx = self.pool.begin().await?;
        if let Some(mid) = machine_id {
            Self::lock_bindable_machine(&mut tx, mid, user_id, org_id).await?;
        }
        let updated = match sqlx::query_scalar::<_, Uuid>(
            "UPDATE projects SET \
             name = COALESCE($3, name), \
             folder = COALESCE($4, folder), \
             machine_id = COALESCE($5, machine_id), \
             archived_at = CASE \
               WHEN $6::bool IS NULL THEN archived_at \
               WHEN $6::bool THEN now() \
               ELSE NULL END \
             WHERE org_id = $1 AND id = $2 AND user_id = $7 \
             RETURNING id",
        )
        .bind(org_id)
        .bind(project_id)
        .bind(name)
        .bind(folder)
        .bind(machine_id)
        .bind(archived)
        .bind(user_id)
        .fetch_optional(&mut *tx)
        .await
        {
            Ok(row) => row.ok_or_else(|| ApiError::not_found("no such project"))?,
            Err(sqlx::Error::Database(db)) if db.is_unique_violation() => {
                return Err(ApiError::conflict(
                    "folder_taken",
                    "a project for this folder already exists on this machine",
                ));
            }
            Err(e) => return Err(ApiError::from(e)),
        };
        // The chat machine binding is project-derived: bound chats follow
        // the project's machine (registry label, machine-id fallback — the
        // same rule the acceptance path writes) in the same transaction, so
        // no send can pair the old executor with the edited folder.
        sqlx::query(
            "UPDATE chats SET machine_id = p.machine_id, machine_label = coalesce(m.label, p.machine_id) \
             FROM projects p LEFT JOIN machines m ON m.machine_id = p.machine_id \
             WHERE p.id = $1 AND chats.project_id = p.id",
        )
        .bind(updated)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        self.fetch_by_id(updated).await
    }

    /// Deletes the project in one transaction with the unlink: referencing
    /// chats keep their history and become folderless (project_id = NULL).
    /// The machine binding is project-derived, so the unlink clears it too —
    /// a machine-bound chat with no project is not a valid state.
    pub async fn delete(
        &self,
        org_id: Uuid,
        project_id: Uuid,
        user_id: Uuid,
    ) -> Result<(), ApiError> {
        let mut tx = self.pool.begin().await?;
        let n = sqlx::query(
            "DELETE FROM projects \
             WHERE org_id = $1 AND id = $2 AND user_id = $3",
        )
        .bind(org_id)
        .bind(project_id)
        .bind(user_id)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if n == 0 {
            return Err(ApiError::not_found("no such project"));
        }
        sqlx::query(
            "UPDATE chats SET project_id = NULL, machine_id = NULL, machine_label = NULL \
             WHERE project_id = $1",
        )
        .bind(project_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// The joined row by id — after a write the caller is already scoped, so
    /// no owner filter here.
    async fn fetch_by_id(&self, id: Uuid) -> Result<ProjectRow, ApiError> {
        sqlx::query_as(&format!(
            "SELECT {ROW_COLUMNS} FROM {ROW_FROM} WHERE p.id = $1"
        ))
        .bind(id)
        .fetch_one(self.pool)
        .await
        .map_err(Into::into)
    }
}

#[cfg(all(test, feature = "test-support"))]
mod tests {
    use crate::store::Store;

    async fn fixture() -> (
        crate::store::TestDb,
        uuid::Uuid,
        crate::store::identity::UserRow,
    ) {
        let db = Store::connect_test().await.unwrap();
        let store = &db.store;
        let org = uuid::Uuid::now_v7();
        sqlx::query("INSERT INTO orgs (id, name) VALUES ($1, 'test')")
            .bind(org)
            .execute(store.pool())
            .await
            .unwrap();
        let user = store
            .identity()
            .create_user(org, "proj@example.org", "hunter226", "member")
            .await
            .unwrap();
        // The default test machine exists in the registry: binding writes
        // enforce bindability inside their own transaction.
        store
            .machines()
            .upsert_connected(
                org,
                user.id,
                "machine-1",
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap();
        (db, org, user)
    }

    /// CRUD roundtrip: create → list → update; a duplicate name is a 409.
    #[tokio::test]
    async fn projects_crud_and_duplicate_names_allowed() {
        let (db, org, user) = fixture().await;
        let store = &db.store;
        let projects = store.projects();
        let created = projects
            .create(org, user.id, "web", r"C:\code\web", "machine-1")
            .await
            .unwrap();
        assert_eq!(created.name, "web");
        // No registry row for the machine: the label falls back to the
        // machine id (uniform on every project-derived label write).
        assert_eq!(created.machine_label.as_deref(), Some("machine-1"));

        // Duplicate names are allowed (folder-derived labels), same user
        // or different users alike.
        let _dup = projects
            .create(org, user.id, "web", r"D:\other", "machine-1")
            .await
            .unwrap();

        // Same name for a different user is fine as well.
        let other = store
            .identity()
            .create_user(org, "proj2@example.org", "hunter226", "member")
            .await
            .unwrap();
        projects
            .create(org, other.id, "web", r"C:\x", "machine-1")
            .await
            .unwrap();

        let listed = projects.list(org, user.id).await.unwrap();
        assert_eq!(listed.len(), 2);
        assert!(listed.iter().any(|p| p.id == created.id));

        let updated = projects
            .update(
                org,
                created.id,
                user.id,
                Some("web2"),
                Some(r"C:\code\web2"),
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(updated.name, "web2");
        assert_eq!(updated.folder, r"C:\code\web2");

        // A member cannot update or see another member's project.
        let foreign = projects.get(org, created.id, other.id).await;
        assert_eq!(
            foreign.unwrap_err().status,
            axum::http::StatusCode::NOT_FOUND
        );

        // An admin is scoped the same way: no visibility into others' projects.
        let admin = store
            .identity()
            .create_user(org, "proj-admin@example.org", "hunter226", "admin")
            .await
            .unwrap();
        assert!(projects.list(org, admin.id).await.unwrap().is_empty());
        let admin_get = projects.get(org, created.id, admin.id).await;
        assert_eq!(
            admin_get.unwrap_err().status,
            axum::http::StatusCode::NOT_FOUND
        );
    }

    /// One live project per (machine, folder): a duplicate create is a 409
    /// — same user, another user of the shared machine, a case variant, or
    /// a trailing-separator variant alike — while the same folder on another
    /// machine and another folder on the same machine bind fine. Archiving
    /// the holder frees the folder, and an update onto a held folder is a
    /// 409 too.
    #[tokio::test]
    async fn project_folder_unique_per_live_machine_binding() {
        let (db, org, user) = fixture().await;
        let store = &db.store;
        store
            .machines()
            .upsert_connected(
                org,
                user.id,
                "machine-2",
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap();
        let projects = store.projects();
        let folder = r"C:\code\web";
        let created = projects
            .create(org, user.id, "web", folder, "machine-1")
            .await
            .unwrap();

        let conflict = |status: axum::http::StatusCode| {
            assert_eq!(status, axum::http::StatusCode::CONFLICT);
        };
        // Exact duplicate, same user.
        conflict(
            projects
                .create(org, user.id, "web again", folder, "machine-1")
                .await
                .unwrap_err()
                .status,
        );
        // Case-folded and trailing-separator variants are the same folder.
        conflict(
            projects
                .create(org, user.id, "web", r"c:\CODE\web\", "machine-1")
                .await
                .unwrap_err()
                .status,
        );
        // A second user of the shared machine is guarded the same way —
        // the executor would drive one working tree from two projects.
        let other = store
            .identity()
            .create_user(org, "proj-dup@example.org", "hunter226", "member")
            .await
            .unwrap();
        conflict(
            projects
                .create(org, other.id, "theirs", folder, "machine-1")
                .await
                .unwrap_err()
                .status,
        );
        // A different folder on the same machine and the same folder on a
        // different machine both bind.
        projects
            .create(org, user.id, "api", r"C:\code\api", "machine-1")
            .await
            .unwrap();
        projects
            .create(org, user.id, "web-2", folder, "machine-2")
            .await
            .unwrap();
        // An update onto a held folder is refused; a free folder updates.
        conflict(
            projects
                .update(
                    org,
                    created.id,
                    user.id,
                    None,
                    Some(r"C:\code\api"),
                    None,
                    None,
                )
                .await
                .unwrap_err()
                .status,
        );
        // Archiving the holder frees the folder for a fresh project.
        projects
            .update(org, created.id, user.id, None, None, None, Some(true))
            .await
            .unwrap();
        let rebound = projects
            .create(org, user.id, "web", folder, "machine-1")
            .await
            .unwrap();
        assert_ne!(rebound.id, created.id);
        // …and the archived project still cannot take a live binding back.
        conflict(
            projects
                .update(org, created.id, user.id, None, None, None, Some(false))
                .await
                .unwrap_err()
                .status,
        );
    }

    /// Deleting a project unlinks its chats (project_id → NULL) and clears
    /// the project-derived machine binding in one transaction; the chat
    /// survives, fully unbound.
    #[tokio::test]
    async fn project_delete_unlinks_referencing_chats() {
        let (db, org, user) = fixture().await;
        let store = &db.store;
        let project = store
            .projects()
            .create(org, user.id, "web", r"C:\code\web", "machine-1")
            .await
            .unwrap();
        let chat = store
            .chats()
            .create_chat_with_machine(
                org,
                user.id,
                Some("t"),
                Some(project.id),
                Some("machine-1"),
                Some("machine-1"),
            )
            .await
            .unwrap();
        store
            .projects()
            .delete(org, project.id, user.id)
            .await
            .unwrap();
        let chat = store.chats().get_chat(org, chat.id, &user).await.unwrap();
        assert_eq!(chat.project_id, None);
        assert_eq!(chat.machine_id, None);
        assert_eq!(chat.machine_label, None);
        assert!(store
            .projects()
            .list(org, user.id)
            .await
            .unwrap()
            .is_empty());
    }

    /// Archiving soft-hides: archived projects drop out of `list` but a
    /// direct fetch still resolves; unarchiving brings them back.
    #[tokio::test]
    async fn project_archive_hides_from_list_only() {
        let (db, org, user) = fixture().await;
        let store = &db.store;
        let project = store
            .projects()
            .create(org, user.id, "web", r"C:\code\web", "machine-1")
            .await
            .unwrap();

        store
            .projects()
            .update(org, project.id, user.id, None, None, None, Some(true))
            .await
            .unwrap();
        assert!(store
            .projects()
            .list(org, user.id)
            .await
            .unwrap()
            .is_empty());
        // Direct fetch still resolves — direct links keep working.
        assert_eq!(
            store
                .projects()
                .get(org, project.id, user.id)
                .await
                .unwrap()
                .id,
            project.id
        );

        store
            .projects()
            .update(org, project.id, user.id, None, None, None, Some(false))
            .await
            .unwrap();
        assert_eq!(
            store.projects().list(org, user.id).await.unwrap()[0].id,
            project.id
        );
    }

    /// The binding write enforces bindability inside its own transaction: an
    /// unregistered machine, another org's machine, and an id retired by a
    /// re-pair adoption are all refused at the store level — no paused
    /// writer can reinstall a retired id after adoption commits.
    #[tokio::test]
    async fn project_binding_write_refuses_unregistered_and_retired_machine_ids() {
        let (db, org, user) = fixture().await;
        let store = &db.store;
        store
            .machines()
            .upsert_connected(org, user.id, "m1", None, None, None, None, None, None)
            .await
            .unwrap();
        let other_org = uuid::Uuid::now_v7();
        sqlx::query("INSERT INTO orgs (id, name) VALUES ($1, 'other')")
            .bind(other_org)
            .execute(store.pool())
            .await
            .unwrap();
        let other_user = store
            .identity()
            .create_user(other_org, "other@example.org", "hunter226", "member")
            .await
            .unwrap();
        store
            .machines()
            .upsert_connected(
                other_org,
                other_user.id,
                "m2",
                None,
                None,
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap();

        assert_eq!(
            store
                .projects()
                .create(org, user.id, "x", r"C:\x", "no-such-machine")
                .await
                .unwrap_err()
                .status,
            axum::http::StatusCode::BAD_REQUEST
        );
        assert_eq!(
            store
                .projects()
                .create(org, user.id, "x", r"C:\x", "m2")
                .await
                .unwrap_err()
                .status,
            axum::http::StatusCode::BAD_REQUEST
        );

        // Adoption re-keys m1's row to a new id: binding m1 afterwards is a
        // retired-id reinstall and is refused.
        sqlx::query("UPDATE machines SET hardware_fingerprint = 'fp-x' WHERE machine_id = 'm1'")
            .execute(store.pool())
            .await
            .unwrap();
        store
            .machines()
            .upsert_connected(
                org,
                user.id,
                "m1-new",
                None,
                Some("fp-x"),
                None,
                None,
                None,
                None,
            )
            .await
            .unwrap();
        assert_eq!(
            store
                .projects()
                .create(org, user.id, "x", r"C:\x", "m1")
                .await
                .unwrap_err()
                .status,
            axum::http::StatusCode::BAD_REQUEST
        );
        // The re-keyed id still binds, and the update path enforces the same
        // rule.
        let created = store
            .projects()
            .create(org, user.id, "x", r"C:\x", "m1-new")
            .await
            .unwrap();
        assert_eq!(
            store
                .projects()
                .update(org, created.id, user.id, None, None, Some("m1"), None)
                .await
                .unwrap_err()
                .status,
            axum::http::StatusCode::BAD_REQUEST
        );
    }
}
