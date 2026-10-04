// Chat store (crates/server/src/store/chats.rs port): chat CRUD with the
// owner/admin gate, the sidebar list with its unread projection (chat_reads
// watermark — UI state stays as-is, spec decision 6), project-derived
// machine binding, the approval-mode override, and the generating flag with
// its same-transaction `guild_chat_status` notify.

import { ApiError } from "../errors.js";
import type { PlatformPool } from "../db.js";
import { pgTimestampToRfc3339 } from "../time.js";
import { uuidv7 } from "../time.js";
import type { UserRow } from "./identity.js";

export interface ChatRow {
  id: string;
  org_id: string;
  user_id: string;
  title: string | null;
  created_at: string;
  machine_id: string | null;
  machine_label: string | null;
  generating: boolean;
  project_id: string | null;
}

export interface ChatListRow {
  id: string;
  org_id: string;
  user_id: string;
  title: string | null;
  created_at: string;
  machine_id: string | null;
  machine_label: string | null;
  generating: boolean;
  unread: boolean;
  project_id: string | null;
  project_name: string | null;
  project_machine_label: string | null;
}

const CHAT_ROW_SELECT = `SELECT id, org_id, user_id, title,
    to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
    machine_id, machine_label, generating, project_id FROM chats`;

/** Shared SELECT/JOIN for the sidebar lists: the unread projection reads the
 *  caller's read watermark (an assistant turn newer than the marker, on a
 *  non-generating chat); the project and machine joins feed the grouping. */
const LIST_SELECT = `SELECT c.id, c.org_id, c.user_id, c.title,
    to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
    c.machine_id, c.machine_label, c.generating, c.project_id,
    pr.name AS project_name, m.label AS project_machine_label,
    (c.generating = false AND EXISTS (
      SELECT 1 FROM thread_events e
      WHERE e.chat_id = c.id AND e.type = 'assistant_message'
        AND (r.last_read_event_id IS NULL OR e.id > r.last_read_event_id))) AS unread
  FROM chats c
  LEFT JOIN chat_reads r ON r.chat_id = c.id AND r.user_id = $2
  LEFT JOIN projects pr ON pr.id = c.project_id
  LEFT JOIN machines m ON m.machine_id = pr.machine_id`;

function rowToChat(r: Record<string, unknown>): ChatRow {
  return {
    id: r.id as string,
    org_id: r.org_id as string,
    user_id: r.user_id as string,
    title: (r.title as string | null) ?? null,
    created_at: pgTimestampToRfc3339(r.created_at as string),
    machine_id: (r.machine_id as string | null) ?? null,
    machine_label: (r.machine_label as string | null) ?? null,
    generating: Boolean(r.generating),
    project_id: (r.project_id as string | null) ?? null,
  };
}

export class ChatStore {
  constructor(private readonly pool: PlatformPool) {}

  /** Creates a chat on a caller-supplied executor (the agent-session create
   *  handler runs it inside its own transaction, uncommitted until the
   *  workspace is ready). */
  async createChatOn(
    client: { query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> },
    orgId: string,
    userId: string,
    title: string | null,
    projectId: string | null,
  ): Promise<ChatRow> {
    const id = uuidv7();
    const res = await client.query(
      `INSERT INTO chats (id, org_id, user_id, title, project_id, machine_id, machine_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, org_id, user_id, title,
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
         machine_id, machine_label, generating, project_id`,
      [id, orgId, userId, title, projectId, null, null],
    );
    return rowToChat(res.rows[0]!);
  }

  async createChat(orgId: string, userId: string, title: string | null, projectId: string | null): Promise<ChatRow> {
    const id = uuidv7();
    const res = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO chats (id, org_id, user_id, title, project_id, machine_id, machine_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, org_id, user_id, title,
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
         machine_id, machine_label, generating, project_id`,
      [id, orgId, userId, title, projectId, null, null],
    );
    return rowToChat(res.rows[0]!);
  }

  /** Creates a chat bound to its project's machine (bind-time inheritance):
   *  the project row is locked and its machine binding read inside the same
   *  transaction as the INSERT, so a concurrent re-pair adoption can never
   *  slip a retired machine id between the read and the write. */
  async createChatForProject(orgId: string, userId: string, title: string | null, projectId: string): Promise<ChatRow> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const binding = await client.query<{ machine_id: string; label: string | null }>(
        `SELECT p.machine_id, coalesce(m.label, p.machine_id) AS label
         FROM projects p LEFT JOIN machines m ON m.machine_id = p.machine_id
         WHERE p.id = $1 AND p.org_id = $2 AND p.user_id = $3 FOR UPDATE OF p`,
        [projectId, orgId, userId],
      );
      const row = binding.rows[0];
      if (!row) throw new ApiError(404, "not_found", "no such project");
      const id = uuidv7();
      const res = await client.query<Record<string, unknown>>(
        `INSERT INTO chats (id, org_id, user_id, title, project_id, machine_id, machine_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, org_id, user_id, title,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
           machine_id, machine_label, generating, project_id`,
        [id, orgId, userId, title, projectId, row.machine_id, row.label],
      );
      await client.query("COMMIT");
      return rowToChat(res.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async listChats(orgId: string, userId: string): Promise<ChatListRow[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      `${LIST_SELECT} WHERE c.org_id = $1 AND c.user_id = $2 AND c.archived_at IS NULL
       ORDER BY c.created_at DESC, c.id DESC`,
      [orgId, userId],
    );
    return res.rows.map(rowToList);
  }

  async listArchivedChats(orgId: string, userId: string): Promise<ChatListRow[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT c.id, c.org_id, c.user_id, c.title,
              to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
              c.machine_id, c.machine_label, c.generating, c.project_id,
              pr.name AS project_name, m.label AS project_machine_label, false AS unread
       FROM chats c
       LEFT JOIN projects pr ON pr.id = c.project_id
       LEFT JOIN machines m ON m.machine_id = pr.machine_id
       WHERE c.org_id = $1 AND c.user_id = $2 AND c.archived_at IS NOT NULL
       ORDER BY c.created_at DESC, c.id DESC`,
      [orgId, userId],
    );
    return res.rows.map(rowToList);
  }

  /** Org-scoped fetch with the owner/admin gate (members must not read
   *  other members' threads, forge events, or spend the org's tokens). */
  async getChat(orgId: string, chatId: string, caller: UserRow): Promise<ChatRow> {
    const isAdmin = caller.role === "admin";
    const res = await this.pool.query<Record<string, unknown>>(
      `${CHAT_ROW_SELECT} WHERE org_id = $1 AND id = $2 AND (user_id = $3 OR $4)`,
      [orgId, chatId, caller.id, isAdmin],
    );
    const row = res.rows[0];
    if (!row) throw new ApiError(404, "not_found", "no such chat");
    return rowToChat(row);
  }

  /** Renames and/or archives the chat (owner-scoped, admin bypass).
   *  Archiving stamps archived_at and settles every waiting command as
   *  cancelled in the same transaction; the chats row lock is taken BEFORE
   *  the settle so the ordering serializes against turn acceptance. */
  async updateChat(
    orgId: string,
    chatId: string,
    caller: UserRow,
    title: string | null | undefined,
    archived: boolean | null | undefined,
  ): Promise<ChatRow> {
    const isAdmin = caller.role === "admin";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query(
        "SELECT id FROM chats WHERE org_id = $1 AND id = $2 AND (user_id = $3 OR $4) FOR UPDATE",
        [orgId, chatId, caller.id, isAdmin],
      );
      if (locked.rowCount === 0) throw new ApiError(404, "not_found", "no such chat");
      const res = await client.query<Record<string, unknown>>(
        `UPDATE chats SET title = COALESCE($3, title),
           archived_at = CASE
             WHEN $4::bool IS NULL THEN archived_at
             WHEN $4::bool THEN now()
             ELSE NULL END
         WHERE org_id = $1 AND id = $2 AND (user_id = $5 OR $6)
         RETURNING id, org_id, user_id, title,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
           machine_id, machine_label, generating, project_id`,
        [orgId, chatId, title, archived, caller.id, isAdmin],
      );
      if (res.rowCount === 0) throw new ApiError(404, "not_found", "no such chat");
      if (archived === true) {
        await client.query(
          "UPDATE turn_commands SET status = 'cancelled', finished_at = now() WHERE chat_id = $1 AND finished_at IS NULL AND status IN ('pending','submitted')",
          [chatId],
        );
      }
      await client.query("COMMIT");
      return rowToChat(res.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Sets (or clears) the chat's machine binding — only the
   *  project-alignment path calls this. The registry row is locked inside
   *  the write tx so a stale cached machine can never be reinstated over an
   *  adopted binding. */
  async setMachine(orgId: string, chatId: string, machineId: string | null, machineLabel: string | null): Promise<ChatRow> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (machineId !== null) {
        const known = await client.query(
          "SELECT machine_id FROM machines WHERE machine_id = $1 AND org_id = $2 FOR UPDATE",
          [machineId, orgId],
        );
        if (known.rowCount === 0) throw new ApiError(400, "bad_request", "unknown machine");
      }
      const res = await client.query<Record<string, unknown>>(
        `UPDATE chats SET machine_id = $3, machine_label = $4
         WHERE org_id = $1 AND id = $2
         RETURNING id, org_id, user_id, title,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
           machine_id, machine_label, generating, project_id`,
        [orgId, chatId, machineId, machineLabel],
      );
      await client.query("COMMIT");
      return rowToChat(res.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Sets (or clears, with null) the chat's project; the machine binding is
   *  project-derived and rides the same UPDATE (a chat runs where its
   *  project's folder lives); clearing the project clears the machine. */
  async setProject(orgId: string, chatId: string, caller: UserRow, projectId: string | null): Promise<ChatRow> {
    const isAdmin = caller.role === "admin";
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      let machine: { machine_id: string | null; label: string | null } | undefined;
      if (projectId !== null) {
        const res = await client.query<{ machine_id: string | null; label: string | null }>(
          `SELECT p.machine_id, m.label FROM projects p
           LEFT JOIN machines m ON m.machine_id = p.machine_id
           WHERE p.org_id = $1 AND p.id = $2 AND p.user_id = $3 FOR UPDATE OF p`,
          [orgId, projectId, caller.id],
        );
        machine = res.rows[0];
        if (!machine) throw new ApiError(404, "not_found", "no such project");
      }
      const res = await client.query<Record<string, unknown>>(
        `UPDATE chats SET project_id = $7, machine_id = $5, machine_label = $6
         WHERE org_id = $1 AND id = $2 AND (user_id = $3 OR $4)
         RETURNING id, org_id, user_id, title,
           to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
           machine_id, machine_label, generating, project_id`,
        [
          orgId,
          chatId,
          caller.id,
          isAdmin,
          machine?.machine_id ?? null,
          machine?.label ?? null,
          projectId,
        ],
      );
      if (res.rowCount === 0) throw new ApiError(404, "not_found", "no such chat");
      await client.query("COMMIT");
      return rowToChat(res.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** The caller-visible project binding (projects().get): name, folder,
   *  machine id + label. Undefined when the project doesn't exist or the
   *  caller has no visibility over it (an admin sending on another
   *  member's chat keeps the cached binding). */
  async projectForBinding(
    orgId: string,
    projectId: string,
    userId: string,
  ): Promise<{ id: string; name: string; folder: string; machine_id: string; machine_label: string | null } | undefined> {
    const res = await this.pool.query<{
      id: string;
      name: string;
      folder: string;
      machine_id: string;
      machine_label: string | null;
    }>(
      `SELECT p.id, p.name, p.folder, p.machine_id, m.label AS machine_label
       FROM projects p LEFT JOIN machines m ON m.machine_id = p.machine_id
       WHERE p.org_id = $1 AND p.id = $2 AND p.user_id = $3`,
      [orgId, projectId, userId],
    );
    return res.rows[0];
  }

  /** The chat's project (id, name, machine label) — org-scoped plain read. */
  async projectOf(orgId: string, chatId: string): Promise<{ id: string; name: string; label: string | null } | undefined> {
    const res = await this.pool.query<{ id: string; name: string; label: string | null }>(
      `SELECT pr.id, pr.name, m.label
       FROM chats c
       JOIN projects pr ON pr.id = c.project_id
       LEFT JOIN machines m ON m.machine_id = pr.machine_id
       WHERE c.org_id = $1 AND c.id = $2`,
      [orgId, chatId],
    );
    return res.rows[0];
  }

  /** Sets (or clears, with null) the chat's approval-mode override —
   *  the composer's per-chat policy (chats.approval, migration 0043/0044). */
  async setApproval(orgId: string, userId: string, chatId: string, policy: Record<string, unknown> | null): Promise<void> {
    const res = await this.pool.query(
      "UPDATE chats SET approval = $4::jsonb WHERE org_id = $1 AND id = $2 AND user_id = $3",
      [orgId, chatId, userId, policy === null ? null : JSON.stringify(policy)],
    );
    if (res.rowCount === 0) throw new ApiError(404, "not_found", "no such chat");
  }

  /** The chat's approval-mode override (owner-scoped; null = account
   *  default applies). */
  async approval(orgId: string, userId: string, chatId: string): Promise<{ default?: string } | null> {
    const res = await this.pool.query<{ approval: { default?: string } | null }>(
      "SELECT approval FROM chats WHERE org_id = $1 AND id = $3 AND user_id = $2",
      [orgId, userId, chatId],
    );
    return res.rows[0]?.approval ?? null;
  }

  /** Flips the generating flag and notifies the status channel in the same
   *  transaction, so no observer sees the flag and the notification
   *  disagree. Silent no-op when the flag already holds the target value. */
  /** The chat's generating flag (the approval route's live-turn check). */
  async isGenerating(orgId: string, chatId: string): Promise<boolean> {
    const res = await this.pool.query<{ generating: boolean }>(
      "SELECT generating FROM chats WHERE org_id = $1 AND id = $2",
      [orgId, chatId],
    );
    return res.rows[0]?.generating ?? false;
  }

  async setGenerating(orgId: string, chatId: string, generating: boolean): Promise<void> {
    const res = await this.pool.query<{ user_id: string }>(
      "UPDATE chats SET generating = $3 WHERE org_id = $1 AND id = $2 AND generating IS DISTINCT FROM $3 RETURNING user_id",
      [orgId, chatId, generating],
    );
    if (res.rows[0]) {
      await this.notifyChatStatus(orgId, res.rows[0].user_id, chatId, generating);
    }
  }

  private async notifyChatStatus(orgId: string, userId: string, chatId: string, generating: boolean): Promise<void> {
    // Same channel and payload the Rust notify_chat_status sends (the member
    // socket's listener flips the sidebar spinner): "generating:<bool>".
    await this.pool.query("SELECT pg_notify('guild_chat_status', $1)", [
      JSON.stringify({ org_id: orgId, user_id: userId, chat_id: chatId, generating }),
    ]);
  }

  /** Marks the chat read for the caller: the marker moves to the newest
   *  thread event. A chat with no events has nothing unread — no marker. */
  async markRead(orgId: string, chatId: string, caller: UserRow): Promise<void> {
    await this.getChat(orgId, chatId, caller);
    const last = await this.pool.query<{ id: string }>(
      "SELECT id FROM thread_events WHERE chat_id = $1 ORDER BY seq DESC LIMIT 1",
      [chatId],
    );
    const lastReadEventId = last.rows[0]?.id;
    if (!lastReadEventId) return;
    await this.pool.query(
      `INSERT INTO chat_reads (chat_id, user_id, last_read_event_id) VALUES ($1, $2, $3)
       ON CONFLICT (chat_id, user_id) DO UPDATE SET last_read_event_id = EXCLUDED.last_read_event_id`,
      [chatId, caller.id, lastReadEventId],
    );
  }
}

function rowToList(r: Record<string, unknown>): ChatListRow {
  return {
    id: r.id as string,
    org_id: r.org_id as string,
    user_id: r.user_id as string,
    title: (r.title as string | null) ?? null,
    created_at: pgTimestampToRfc3339(r.created_at as string),
    machine_id: (r.machine_id as string | null) ?? null,
    machine_label: (r.machine_label as string | null) ?? null,
    generating: Boolean(r.generating),
    unread: Boolean(r.unread),
    project_id: (r.project_id as string | null) ?? null,
    project_name: (r.project_name as string | null) ?? null,
    project_machine_label: (r.project_machine_label as string | null) ?? null,
  };
}

/** Fetches one chat the caller owns. Admins may access any chat in the
 *  org; everyone else only their own — org scoping alone would let a
 *  member read another member's thread, forge its events, rebind its
 *  machine, or spend the org's tokens through it. (Attachment-route
 *  helper, kept from the M1 store shape.) */
export async function getChatOwned(
  pool: PlatformPool,
  orgId: string,
  chatId: string,
  caller: UserRow,
): Promise<ChatRow> {
  const store = new ChatStore(pool);
  return store.getChat(orgId, chatId, caller);
}
