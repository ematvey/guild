//! Org-scoped projects (spec §1): a named folder bound to a machine. Chats
//! attach to a project (`chats.project_id`) and the ChatRunner resolves the
//! workspace folder from it. Owner-scoped access with admin bypass, the same
//! shape as chats.

use crate::http::error::ApiError;
use crate::store::identity::UserRow;
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
    /// Creates a project. The (user_id, name) pair is unique: a duplicate
    /// name is a 409, not a 500.
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
        .await
        .map_err(unique_name_taken)?;
        debug_assert_eq!(result.rows_affected(), 1);
        self.fetch_by_id(id).await
    }

    /// Lists the caller's projects; admins see every project in the org.
    pub async fn list(
        &self,
        org_id: Uuid,
        user_id: Uuid,
        caller: &UserRow,
    ) -> Result<Vec<ProjectRow>, ApiError> {
        let is_admin = caller.role == "admin";
        sqlx::query_as(&format!(
            "SELECT {ROW_COLUMNS} FROM {ROW_FROM} \
             WHERE p.org_id = $1 AND (p.user_id = $2 OR $3) \
             ORDER BY p.created_at DESC"
        ))
        .bind(org_id)
        .bind(user_id)
        .bind(is_admin)
        .fetch_all(self.pool)
        .await
        .map_err(Into::into)
    }

    /// Fetches one project the caller owns; admins pass (mirror get_chat).
    pub async fn get(
        &self,
        org_id: Uuid,
        project_id: Uuid,
        caller: &UserRow,
    ) -> Result<ProjectRow, ApiError> {
        let is_admin = caller.role == "admin";
        sqlx::query_as(&format!(
            "SELECT {ROW_COLUMNS} FROM {ROW_FROM} \
             WHERE p.org_id = $1 AND p.id = $2 AND (p.user_id = $3 OR $4)"
        ))
        .bind(org_id)
        .bind(project_id)
        .bind(caller.id)
        .bind(is_admin)
        .fetch_optional(self.pool)
        .await?
        .ok_or_else(|| ApiError::not_found("no such project"))
    }

    /// Updates the editable fields (`None` = keep). A duplicate name is a 409.
    pub async fn update(
        &self,
        org_id: Uuid,
        project_id: Uuid,
        caller: &UserRow,
        name: Option<&str>,
        folder: Option<&str>,
        machine_id: Option<&str>,
    ) -> Result<ProjectRow, ApiError> {
        let updated = sqlx::query_scalar::<_, Uuid>(
            "UPDATE projects SET \
             name = COALESCE($3, name), \
             folder = COALESCE($4, folder), \
             machine_id = COALESCE($5, machine_id) \
             WHERE org_id = $1 AND id = $2 AND (user_id = $6 OR $7) \
             RETURNING id",
        )
        .bind(org_id)
        .bind(project_id)
        .bind(name)
        .bind(folder)
        .bind(machine_id)
        .bind(caller.id)
        .bind(caller.role == "admin")
        .fetch_optional(self.pool)
        .await
        .map_err(unique_name_taken)?
        .ok_or_else(|| ApiError::not_found("no such project"))?;
        self.fetch_by_id(updated).await
    }

    /// Deletes the project in one transaction with the unlink: referencing
    /// chats keep their history and become folderless (project_id = NULL).
    pub async fn delete(
        &self,
        org_id: Uuid,
        project_id: Uuid,
        caller: &UserRow,
    ) -> Result<(), ApiError> {
        let is_admin = caller.role == "admin";
        let mut tx = self.pool.begin().await?;
        let n = sqlx::query(
            "DELETE FROM projects \
             WHERE org_id = $1 AND id = $2 AND (user_id = $3 OR $4)",
        )
        .bind(org_id)
        .bind(project_id)
        .bind(caller.id)
        .bind(is_admin)
        .execute(&mut *tx)
        .await?
        .rows_affected();
        if n == 0 {
            return Err(ApiError::not_found("no such project"));
        }
        sqlx::query("UPDATE chats SET project_id = NULL WHERE project_id = $1")
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

/// A (user_id, name) unique-violation is the caller's duplicate project
/// name — a 409, not a 500. Every other error passes through.
fn unique_name_taken(e: sqlx::Error) -> ApiError {
    if let sqlx::Error::Database(db) = &e {
        if db
            .constraint()
            .is_some_and(|c| c.contains("projects_user_id_name_key"))
        {
            return ApiError::conflict(
                "project_name_taken",
                "a project with this name already exists",
            );
        }
    }
    e.into()
}

#[cfg(all(test, feature = "test-support"))]
mod tests {
    use crate::store::Store;

    async fn fixture() -> (crate::store::TestDb, uuid::Uuid, crate::store::identity::UserRow) {
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
    async fn projects_crud_and_duplicate_name_conflict() {
        let (db, org, user) = fixture().await;
        let store = &db.store;
        let projects = store.projects();
        let created = projects
            .create(org, user.id, "web", r"C:\code\web", "machine-1")
            .await
            .unwrap();
        assert_eq!(created.name, "web");
        assert_eq!(created.machine_label, None);

        let dup = projects
            .create(org, user.id, "web", r"D:\other", "machine-1")
            .await
            .unwrap_err();
        assert_eq!(dup.status, axum::http::StatusCode::CONFLICT);

        // Same name for a different user is fine (unique per user).
        let other = store
            .identity()
            .create_user(org, "proj2@example.org", "hunter226", "member")
            .await
            .unwrap();
        projects
            .create(org, other.id, "web", r"C:\x", "machine-1")
            .await
            .unwrap();

        let listed = projects.list(org, user.id, &user).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);

        let updated = projects
            .update(org, created.id, &user, Some("web2"), Some(r"C:\code\web2"), None)
            .await
            .unwrap();
        assert_eq!(updated.name, "web2");
        assert_eq!(updated.folder, r"C:\code\web2");

        // A member cannot update or see another member's project.
        let foreign = projects.get(org, created.id, &other).await;
        assert_eq!(
            foreign.unwrap_err().status,
            axum::http::StatusCode::NOT_FOUND
        );
    }

    /// Deleting a project unlinks its chats (project_id → NULL) in one
    /// transaction; the chat survives.
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
            .create_chat(org, user.id, Some("t"), Some(project.id))
            .await
            .unwrap();
        store
            .projects()
            .delete(org, project.id, &user)
            .await
            .unwrap();
        let chat = store.chats().get_chat(org, chat.id, &user).await.unwrap();
        assert_eq!(chat.project_id, None);
        assert!(store.projects().list(org, user.id, &user).await.unwrap().is_empty());
    }
}
