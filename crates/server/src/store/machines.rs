//! Durable machine registry: one row per desktop pairing. The connection
//! hub owns liveness; this table is the durable record the machines page
//! and bind checks read (spec §2.3). Writes happen at socket connect
//! (upsert with fingerprint adoption) and on a 30 s-throttled ping
//! heartbeat (last_seen).

use crate::http::error::ApiError;
use chrono::{DateTime, Utc};
use uuid::Uuid;

#[derive(Debug, Clone, sqlx::FromRow, serde::Serialize)]
pub struct MachineRow {
    pub machine_id: String,
    pub org_id: Uuid,
    pub user_id: Uuid,
    pub label: Option<String>,
    pub hardware_fingerprint: Option<String>,
    pub os: Option<String>,
    pub os_version: Option<String>,
    pub app_version: Option<String>,
    pub last_ip: Option<String>,
    pub first_connected_at: DateTime<Utc>,
    pub last_connected_at: DateTime<Utc>,
    pub last_seen_at: DateTime<Utc>,
    pub re_paired_at: Option<DateTime<Utc>>,
}

/// Result of a connect-time registration. `adopted_from` is set when the
/// fingerprint matched an existing row of the same org and that row was
/// re-keyed to the incoming machine_id: any live socket still registered
/// under the old id must be displaced (singleton rule).
pub struct UpsertOutcome {
    pub row: MachineRow,
    pub adopted_from: Option<String>,
}

pub struct MachineStore<'a> {
    pub(crate) pool: &'a sqlx::PgPool,
}

/// Empty query values are stored as NULL, never as '' (desktop 0.4.0 omits
/// the metadata params entirely; Task 3 adds them).
fn non_empty(value: Option<&str>) -> Option<&str> {
    value.filter(|v| !v.is_empty())
}

const ROW_COLUMNS: &str = "machine_id, org_id, user_id, label, hardware_fingerprint, os, \
     os_version, app_version, last_ip, first_connected_at, last_connected_at, last_seen_at, \
     re_paired_at";

impl<'a> MachineStore<'a> {
    /// Registers a machine connect. A known machine_id of the same org is a
    /// reconnect (metadata refresh only, never a re-key). An unknown
    /// machine_id is a new registration: a fingerprint match on the same
    /// org adopts the old row — its machine_id is re-keyed to the incoming
    /// one (thread bindings keep working through the caller's id), and
    /// re_paired_at is stamped. No match inserts a fresh row.
    ///
    /// A machine_id already registered to a DIFFERENT org is left untouched
    /// (client-issued ids make cross-org claims untrustworthy until Task 2
    /// moves issuance server-side); the returned row is the untouched
    /// foreign row and the connect is not registered.
    #[allow(clippy::too_many_arguments)]
    pub async fn upsert_connected(
        &self,
        org_id: Uuid,
        user_id: Uuid,
        machine_id: &str,
        label: Option<&str>,
        fingerprint: Option<&str>,
        os: Option<&str>,
        os_version: Option<&str>,
        app_version: Option<&str>,
        ip: Option<&str>,
    ) -> Result<UpsertOutcome, ApiError> {
        let label = non_empty(label);
        let fingerprint = non_empty(fingerprint);
        let os = non_empty(os);
        let os_version = non_empty(os_version);
        let app_version = non_empty(app_version);
        let ip = non_empty(ip);

        let mut tx = self.pool.begin().await?;
        let existing: Option<MachineRow> = sqlx::query_as(&format!(
            "SELECT {ROW_COLUMNS} FROM machines WHERE machine_id = $1 FOR UPDATE"
        ))
        .bind(machine_id)
        .fetch_optional(&mut *tx)
        .await?;

        if let Some(foreign) = existing.as_ref().filter(|row| row.org_id != org_id) {
            tx.rollback().await?;
            return Ok(UpsertOutcome {
                row: foreign.clone(),
                adopted_from: None,
            });
        }

        if existing.is_some() {
            // Reconnect of a known machine: refresh metadata and timestamps.
            // NULL metadata never erases what an earlier connect reported.
            let row: MachineRow = sqlx::query_as(&format!(
                "UPDATE machines SET \
                 label = COALESCE($2, label), \
                 hardware_fingerprint = COALESCE($3, hardware_fingerprint), \
                 os = COALESCE($4, os), \
                 os_version = COALESCE($5, os_version), \
                 app_version = COALESCE($6, app_version), \
                 last_ip = COALESCE($7, last_ip), \
                 last_connected_at = now(), last_seen_at = now() \
                 WHERE machine_id = $1 \
                 RETURNING {ROW_COLUMNS}"
            ))
            .bind(machine_id)
            .bind(label)
            .bind(fingerprint)
            .bind(os)
            .bind(os_version)
            .bind(app_version)
            .bind(ip)
            .fetch_one(&mut *tx)
            .await?;
            tx.commit().await?;
            return Ok(UpsertOutcome {
                row,
                adopted_from: None,
            });
        }

        // New registration: fingerprint adoption within the same org.
        if let Some(fingerprint) = fingerprint {
            let old: Option<MachineRow> = sqlx::query_as(&format!(
                "SELECT {ROW_COLUMNS} FROM machines \
                 WHERE org_id = $1 AND hardware_fingerprint = $2 \
                 ORDER BY last_seen_at DESC LIMIT 1 FOR UPDATE"
            ))
            .bind(org_id)
            .bind(fingerprint)
            .fetch_optional(&mut *tx)
            .await?;
            if let Some(old) = old {
                // Same physical machine, new pairing identity: re-key the old
                // row to the incoming machine_id so thread bindings survive,
                // and treat the connect as a fresh pairing.
                let row: MachineRow = sqlx::query_as(&format!(
                    "UPDATE machines SET \
                     machine_id = $2, user_id = $3, \
                     label = COALESCE($4, label), \
                     os = COALESCE($5, os), \
                     os_version = COALESCE($6, os_version), \
                     app_version = COALESCE($7, app_version), \
                     last_ip = COALESCE($8, last_ip), \
                     last_connected_at = now(), last_seen_at = now(), \
                     re_paired_at = now() \
                     WHERE machine_id = $1 \
                     RETURNING {ROW_COLUMNS}"
                ))
                .bind(&old.machine_id)
                .bind(machine_id)
                .bind(user_id)
                .bind(label)
                .bind(os)
                .bind(os_version)
                .bind(app_version)
                .bind(ip)
                .fetch_one(&mut *tx)
                .await?;
                tx.commit().await?;
                return Ok(UpsertOutcome {
                    row,
                    adopted_from: Some(old.machine_id),
                });
            }
        }

        let row: MachineRow = sqlx::query_as(&format!(
            "INSERT INTO machines \
             (machine_id, org_id, user_id, label, hardware_fingerprint, os, os_version, \
              app_version, last_ip) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
             RETURNING {ROW_COLUMNS}"
        ))
        .bind(machine_id)
        .bind(org_id)
        .bind(user_id)
        .bind(label)
        .bind(fingerprint)
        .bind(os)
        .bind(os_version)
        .bind(app_version)
        .bind(ip)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(UpsertOutcome {
            row,
            adopted_from: None,
        })
    }

    /// Refreshes the liveness timestamp; called off the ping heartbeat on a
    /// 30 s throttle.
    pub async fn last_seen(&self, machine_id: &str) -> Result<(), ApiError> {
        sqlx::query("UPDATE machines SET last_seen_at = now() WHERE machine_id = $1")
            .bind(machine_id)
            .execute(self.pool)
            .await?;
        Ok(())
    }

    /// All registry rows of one user's org that belong to them.
    pub async fn list_for_user(
        &self,
        org_id: Uuid,
        user_id: Uuid,
    ) -> Result<Vec<MachineRow>, ApiError> {
        Ok(sqlx::query_as(&format!(
            "SELECT {ROW_COLUMNS} FROM machines \
             WHERE org_id = $1 AND user_id = $2 \
             ORDER BY last_connected_at DESC"
        ))
        .bind(org_id)
        .bind(user_id)
        .fetch_all(self.pool)
        .await?)
    }

    /// True when the machine is durably registered to the user or their
    /// org — the bind check. Offline machines stay bindable; hub liveness
    /// is not consulted.
    pub async fn bindable(
        &self,
        machine_id: &str,
        user_id: Uuid,
        org_id: Uuid,
    ) -> Result<bool, ApiError> {
        let ok: bool = sqlx::query_scalar(
            "SELECT EXISTS (\
             SELECT 1 FROM machines \
             WHERE machine_id = $1 AND (user_id = $2 OR org_id = $3))",
        )
        .bind(machine_id)
        .bind(user_id)
        .bind(org_id)
        .fetch_one(self.pool)
        .await?;
        Ok(ok)
    }
}
