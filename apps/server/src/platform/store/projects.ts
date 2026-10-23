// Org-scoped projects: a named folder
// bound to a machine. Chats attach to a project (chats.project_id).
// Strictly owner-scoped: every operation filters on user_id, with no admin
// bypass — a user, including an admin, sees and touches only their own
// projects.

import { ApiError } from "../errors.js";
import { pgTimestampToRfc3339, uuidv7 } from "../time.js";
import type { PlatformPool, PoolClient } from "../db.js";

/** One project row joined with its machine's registry label (the machines
 *  table is the durable label source; the live hub refines it at render
 *  time). */
export interface ProjectRow {
  id: string;
  org_id: string;
  user_id: string;
  name: string;
  /** Windows path; UNC (`\\wsl.localhost\…`) for a WSL distro folder. */
  folder: string;
  machine_id: string;
  created_at: string;
  machine_label: string | null;
}

const ROW_COLUMNS =
  "p.id, p.org_id, p.user_id, p.name, p.folder, p.machine_id, " +
  "to_char(p.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at, " +
  "coalesce(m.label, p.machine_id) AS machine_label";
const ROW_FROM = "projects p LEFT JOIN machines m ON m.machine_id = p.machine_id";

function row(r: Record<string, unknown>): ProjectRow {
  return {
    id: r.id as string,
    org_id: r.org_id as string,
    user_id: r.user_id as string,
    name: r.name as string,
    folder: r.folder as string,
    machine_id: r.machine_id as string,
    created_at: pgTimestampToRfc3339(r.created_at as string),
    machine_label: (r.machine_label as string | null) ?? null,
  };
}

export class ProjectStore {
  constructor(readonly pool: PlatformPool) {}

  /** Locks the machine's registry row and proves bindability inside the
   *  caller's transaction: a fingerprint adoption (which locks the same row
   *  before re-keying) can never commit between this check and the binding
   *  write. Only the machine's owning user may bind to it — the org check is
   *  tenancy, not permission. A project's folder is the workdir its chats
   *  execute in, so an org-wide bind would let a member run tools on a
   *  coworker's machine. */
  private async lockBindableMachine(
    client: PoolClient,
    machineId: string,
    userId: string,
    orgId: string,
  ): Promise<void> {
    const res = await client.query(
      "SELECT machine_id FROM machines WHERE machine_id = $1 AND user_id = $2 AND org_id = $3 FOR UPDATE",
      [machineId, userId, orgId],
    );
    if (res.rows.length === 0) throw ApiError.badRequest("unknown machine");
  }

  /** Creates a project. Names are display labels derived from the chosen
   *  folder — duplicate names are allowed. The machine must be registered
   *  to the caller. One live project per (machine, folder):
   *  the unique index is the guard (it covers a cross-device race and a
   *  second user of a shared machine); a violation is a 409. Archived
   *  projects step aside and free the folder. */
  async create(orgId: string, userId: string, name: string, folder: string, machineId: string): Promise<ProjectRow> {
    const id = uuidv7();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.lockBindableMachine(client, machineId, userId, orgId);
      try {
        await client.query(
          "INSERT INTO projects (id, org_id, user_id, name, folder, machine_id) VALUES ($1, $2, $3, $4, $5, $6)",
          [id, orgId, userId, name, folder, machineId],
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw ApiError.conflict(
            "folder_taken",
            "a project for this folder already exists on this machine",
          );
        }
        throw error;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.fetchById(id);
  }

  /** Lists the caller's live projects — owner-only, admins included. */
  async list(orgId: string, userId: string): Promise<ProjectRow[]> {
    const res = await this.pool.query(
      `SELECT ${ROW_COLUMNS} FROM ${ROW_FROM} WHERE p.org_id = $1 AND p.user_id = $2 AND p.archived_at IS NULL ORDER BY p.created_at DESC`,
      [orgId, userId],
    );
    return res.rows.map((r: Record<string, unknown>) => row(r));
  }

  /** Lists the caller's archived projects, most recently archived first —
   *  the sidebar's Archived section. */
  async listArchived(orgId: string, userId: string): Promise<ProjectRow[]> {
    const res = await this.pool.query(
      `SELECT ${ROW_COLUMNS} FROM ${ROW_FROM} WHERE p.org_id = $1 AND p.user_id = $2 AND p.archived_at IS NOT NULL ORDER BY p.archived_at DESC`,
      [orgId, userId],
    );
    return res.rows.map((r: Record<string, unknown>) => row(r));
  }

  /** Fetches one project the caller owns — owner-only, admins included. */
  async get(orgId: string, projectId: string, userId: string): Promise<ProjectRow> {
    const res = await this.pool.query(
      `SELECT ${ROW_COLUMNS} FROM ${ROW_FROM} WHERE p.org_id = $1 AND p.id = $2 AND p.user_id = $3`,
      [orgId, projectId, userId],
    );
    const r = res.rows[0];
    if (r === undefined) throw ApiError.notFound("no such project");
    return row(r);
  }

  /** Updates the editable fields (`null` = keep). Duplicate names are
   *  allowed; moving the project onto a machine+folder another live
   *  project holds is a 409. `archived` soft-hides: archived projects drop
   *  out of `list` but direct fetches still resolve, and archiving frees
   *  the folder. The chat machine binding is project-derived: bound chats
   *  follow the project's machine in the same transaction. */
  async update(
    orgId: string,
    projectId: string,
    userId: string,
    name: string | null,
    folder: string | null,
    machineId: string | null,
    archived: boolean | null,
  ): Promise<ProjectRow> {
    let updated: string;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (machineId !== null) {
        await this.lockBindableMachine(client, machineId, userId, orgId);
      }
      try {
        const updRes = await client.query(
          "UPDATE projects SET " +
          "name = COALESCE($3, name), " +
          "folder = COALESCE($4, folder), " +
          "machine_id = COALESCE($5, machine_id), " +
          "archived_at = CASE " +
          "WHEN $6::bool IS NULL THEN archived_at " +
          "WHEN $6::bool THEN now() " +
          "ELSE NULL END " +
          "WHERE org_id = $1 AND id = $2 AND user_id = $7 RETURNING id",
          [orgId, projectId, name, folder, machineId, archived, userId],
        );
        if (updRes.rows.length === 0) throw ApiError.notFound("no such project");
        updated = updRes.rows[0]!.id as string;
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw ApiError.conflict(
            "folder_taken",
            "a project for this folder already exists on this machine",
          );
        }
        throw error;
      }
      await client.query(
        "UPDATE chats SET machine_id = p.machine_id, machine_label = coalesce(m.label, p.machine_id) " +
        "FROM projects p LEFT JOIN machines m ON m.machine_id = p.machine_id " +
        "WHERE p.id = $1 AND chats.project_id = p.id",
        [updated],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return this.fetchById(updated);
  }

  /** Deletes the project in one transaction with the unlink: referencing
   *  chats keep their history and become folderless (project_id = NULL).
   *  The machine binding is project-derived, so the unlink clears it too. */
  async delete(orgId: string, projectId: string, userId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query(
        "DELETE FROM projects WHERE org_id = $1 AND id = $2 AND user_id = $3",
        [orgId, projectId, userId],
      );
      if (res.rowCount === 0) throw ApiError.notFound("no such project");
      await client.query(
        "UPDATE chats SET project_id = NULL, machine_id = NULL, machine_label = NULL WHERE project_id = $1",
        [projectId],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /** The joined row by id — after a write the caller is already scoped, so
   *  no owner filter here. */
  private async fetchById(id: string): Promise<ProjectRow> {
    const res = await this.pool.query(`SELECT ${ROW_COLUMNS} FROM ${ROW_FROM} WHERE p.id = $1`, [id]);
    if (res.rows.length === 0) throw ApiError.notFound("no such project");
    return row(res.rows[0]!);
  }
}
