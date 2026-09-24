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
     m.label AS machine_label";

const ROW_FROM: &str = "projects p LEFT JOIN machines m ON m.machine_id = p.machine_id";

impl<'a> ProjectStore<'a> {
    /// Creates a project. Names are display labels derived from the chosen
    /// folder — duplicates are allowed.
    pub async fn create(
        &self,
        org_id: Uuid,
        user_id: Uuid,
        name: &str,
        folder: &str,
        machine_id: &str,
    ) -> Result<ProjectRow, ApiError> {
        let id = Uuid::now_v7();
        let result = sqlx::query(
            "INSERT INTO projects (id, org_id, user_id, name, folder, machine_id) \
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind(id)
        .bind(org_id)
        .bind(user_id)
        .bind(name)
        .bind(folder)
        .bind(machine_id)
        .execute(self.pool)
        .await?;
        debug_assert_eq!(result.rows_affected(), 1);
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

    /// Updates the editable fields (`None` = keep). A duplicate name is a 409.
    /// `archived` soft-hides: archived projects drop out of `list` but direct
    /// fetches still resolve.
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
        let updated = sqlx::query_scalar::<_, Uuid>(
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
        .await?
        .ok_or_else(|| ApiError::not_found("no such project"))?;
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
        assert_eq!(created.machine_label, None);

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
}
