// Chat store: chat CRUD with its access rule (the owner reads and writes;
// an org admin reads any member's chat but writes only their own), the
// sidebar list with its unread projection (chat_reads
// watermark — UI state stays as-is, spec decision 6), project-derived
// machine binding, the approval-mode override, and the generating flag with
// its same-transaction `guild_chat_status` notify.

import { generationWorkSql } from "./work.js";
import { ApiError } from "../errors.js";
import { withTransaction, type PlatformPool } from "../db.js";
import { jsonbText } from "../domain/text.js";
import { pgTimestampToRfc3339, utcText } from "../time.js";
import { uuidv7 } from "../time.js";
import type { UserRow } from "./identity.js";
import type { AgentThreadType } from "../domain/thread-type.js";

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
  /** The user hid the chat from the sidebar; it still resolves. */
  archived: boolean;
  /** The user removed the chat; it drops out of every list. */
  deleted: boolean;
}

/** The chat's tenant and owner account (ownerOf). */
export interface ChatOwner {
  org_id: string;
  user_id: string;
  email: string;
  display_name: string | null;
  role: string;
}

export type CompactionStatus =
  | { status: "running" }
  | { status: "completed"; compacted: boolean }
  | { status: "failed"; error: string };

export interface ChatListRow {
  id: string;
  org_id: string;
  user_id: string;
  title: string | null;
  created_at: string;
  machine_id: string | null;
  machine_label: string | null;
  generating: boolean;
  /** This chat or any descendant thread has a queued/running run. */
  working: boolean;
  unread: boolean;
  /** A tool call is waiting for the user's approval in this chat. */
  blocked: boolean;
  project_id: string | null;
  project_name: string | null;
  project_machine_label: string | null;
  /** The chat's latest thread event (RFC3339), falling back to created_at
   *  for a chat with no events — the sidebar's recent-activity sort key. */
  last_activity_at: string;
  /** What the chat's thread is. A chat with no thread row is a user chat. */
  type: AgentThreadType;
  archived: boolean;
  deleted: boolean;
}

const CHAT_ROW_SELECT = `SELECT id, org_id, user_id, title,
    ${utcText("created_at")} AS created_at,
    machine_id, machine_label, generating, project_id,
    archived_at IS NOT NULL AS archived, deleted_at IS NOT NULL AS deleted FROM chats`;

/** The chat subtree's running set for the whole list: one recursive walk over
 *  agent_threads, then the chats whose subtree holds a queued/running run. */
const WORKING_CTE = `WITH RECURSIVE subtree AS (
    SELECT t.id AS thread_id, t.chat_id AS root_chat
    FROM agent_threads t
    JOIN chats rc ON rc.id = t.chat_id
    WHERE rc.org_id = $1 AND rc.user_id = $2
    UNION ALL
    SELECT c.id, s.root_chat
    FROM agent_threads c JOIN subtree s ON c.parent_thread_id = s.thread_id
  ),
  working_chats AS (
    SELECT DISTINCT s.root_chat AS chat_id
    FROM subtree s
    JOIN agent_runs r ON r.thread_id = s.thread_id
    WHERE r.status IN ('queued', 'running')
  )`;

/** Shared SELECT/JOIN for the sidebar lists: the unread projection reads the
 *  caller's read watermark (an assistant turn newer than the marker, on a
 *  non-generating chat); the project and machine joins feed the grouping. */
const LIST_SELECT = `${WORKING_CTE} SELECT c.id, c.org_id, c.user_id, c.title,
    ${utcText("c.created_at")} AS created_at,
    c.machine_id, c.machine_label, c.generating,
    (c.generating OR wc.chat_id IS NOT NULL) AS working, c.project_id,
    pr.name AS project_name, m.label AS project_machine_label,
    (c.generating = false AND EXISTS (
      SELECT 1 FROM thread_events e
      WHERE e.chat_id = c.id AND e.type = 'assistant_message'
        AND (r.last_read_seq IS NULL OR e.seq > r.last_read_seq))) AS unread,
    EXISTS (
      SELECT 1 FROM thread_events e
      WHERE e.chat_id = c.id AND e.type = 'approval_request'
        AND e.created_at > now() - interval '10 minutes'
        AND NOT EXISTS (
          SELECT 1 FROM thread_events d
          WHERE d.chat_id = e.chat_id AND d.type = 'approval_decision'
            AND d.seq > e.seq AND d.payload->>'call_id' = e.payload->>'call_id')) AS blocked,
    ${utcText("COALESCE(le.created_at, c.created_at)")} AS last_activity_at,
    COALESCE(xt.type, 'user') AS type,
    c.archived_at IS NOT NULL AS archived,
    c.deleted_at IS NOT NULL AS deleted
  FROM chats c
  LEFT JOIN agent_threads xt ON xt.chat_id = c.id
  LEFT JOIN chat_reads r ON r.chat_id = c.id AND r.user_id = $2
  LEFT JOIN working_chats wc ON wc.chat_id = c.id
  LEFT JOIN projects pr ON pr.id = c.project_id
  LEFT JOIN machines m ON m.machine_id = pr.machine_id
  LEFT JOIN LATERAL (
    SELECT e.created_at FROM thread_events e WHERE e.chat_id = c.id ORDER BY e.seq DESC LIMIT 1
  ) le ON true`;

/** Routine runs and delegation children are execution transcripts, not
 *  conversations: they stay out of the sidebar lists. The HTTP lists and the
 *  WebSocket thread_list push share this one predicate. */
/** A sidebar row is a user conversation: subagent and routine threads are
 *  execution transcripts, reachable by direct link but never listed. */
export const USER_THREAD = `NOT EXISTS (
    SELECT 1 FROM agent_threads xt
    WHERE xt.chat_id = c.id AND xt.type <> 'user'
  )`;

/** The sidebar lists sort by recent activity, not creation: a chat's place
 *  follows its latest thread event (creation is its initial activity), so a
 *  chat with a fresh turn rises above a newer chat that never got one. */
const LIST_ORDER = `ORDER BY COALESCE(le.created_at, c.created_at) DESC, c.id DESC`;

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
    archived: Boolean(r.archived),
    deleted: Boolean(r.deleted),
  };
}

/** The workspace lists a chat-row write can move (the feed re-reads only
 *  these; a `guild_workspace` payload without `parts` moves every list). */
const CHAT_LIST_PARTS = ["chats", "archived"];

/** A new chat is a new sidebar row: the workspace push is what puts it in
 *  every open tab before the first message names it. */
async function notifyChatCreated(
  client: { query: (text: string, values?: unknown[]) => Promise<unknown> },
  orgId: string,
  userId: string,
  chatId: string,
): Promise<void> {
  await client.query("SELECT pg_notify('guild_workspace', $1)", [
    JSON.stringify({ org_id: orgId, user_id: userId, chat_id: chatId, parts: CHAT_LIST_PARTS }),
  ]);
}

/** The `guild_chat_status` NOTIFY for one changed row aliased `u` (the
 *  member socket's listener flips the sidebar spinner from it). */
const STATUS_NOTIFY = `pg_notify('guild_chat_status', json_build_object(
  'org_id', u.org_id, 'user_id', u.user_id, 'chat_id', u.id, 'generating', u.generating)::text)`;

/** Wraps an `UPDATE … RETURNING org_id, user_id, id, generating` so each
 *  changed row notifies the status channel in the same statement. */
function withStatusNotify(update: string): string {
  return `WITH u AS (${update}) SELECT ${STATUS_NOTIFY} FROM u`;
}

export class ChatStore {
  constructor(private readonly pool: PlatformPool) {}

  /** A manual compaction can finish successfully without appending a summary. */
  async compactionStatus(chatId: string, taskId: number): Promise<CompactionStatus | null> {
    // Records are JSON text; parse here instead of casting them to jsonb.
    const result = await this.pool.query<{ status: string; record: string }>(
      `SELECT t.status,t.record FROM tasks t
       JOIN chat_conversations c ON c.conversation_id=t.conversation_id
       WHERE c.chat_id=$1 AND t.id=$2 AND t.kind='"pi.compaction"'`,
      [chatId, taskId],
    );
    const row = result.rows[0];
    if (!row) return null;
    const outcome = (JSON.parse(row.record) as {
      state?: { outcome?: { status: string; result?: { entryId?: number; submissionId?: number }; error?: { message?: string }; reason?: string } };
    }).state?.outcome ?? null;
    if (row.status !== "terminal") return { status: "running" };
    if (outcome?.status === "completed") {
      const submissionId = outcome.result?.submissionId;
      if (submissionId !== undefined) {
        const placed = await this.pool.query<{ status: string; record: string }>(
          `SELECT s.status,s.record FROM submissions s
           JOIN chat_conversations c ON c.conversation_id=s.conversation_id
           WHERE c.chat_id=$1 AND s.id=$2`,
          [chatId, submissionId],
        );
        const placedRow = placed.rows[0];
        const placedRecord = placedRow === undefined
          ? undefined
          : (JSON.parse(placedRow.record) as { type?: string; reason?: string });
        const write = placedRecord?.type === "write" ? placedRow : undefined;
        if (write?.status === "queued") return { status: "running" };
        if (write?.status === "done") return { status: "completed", compacted: true };
        return { status: "failed", error: placedRecord?.reason === "aborted" ? "Compaction was cancelled" : "Compaction summary was superseded or could not be applied" };
      }
      return { status: "completed", compacted: outcome.result?.entryId !== undefined };
    }
    return { status: "failed", error: outcome?.error?.message ?? outcome?.reason ?? "Compaction did not complete" };
  }

  /** The chat's org and owner (the agent tools' caller identity: the
   *  conversation → chat → owner mapping), with the owner's account fields.
   *  null when the chat is gone. */
  async ownerOf(chatId: string): Promise<ChatOwner | null> {
    const res = await this.pool.query<ChatOwner>(
      "SELECT c.org_id, c.user_id, u.email, u.display_name, u.role " +
        "FROM chats c JOIN users u ON u.id = c.user_id WHERE c.id = $1",
      [chatId],
    );
    return res.rows[0] ?? null;
  }

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
         ${utcText("created_at")} AS created_at,
         machine_id, machine_label, generating, project_id`,
      [id, orgId, userId, title, projectId, null, null],
    );
    await notifyChatCreated(client, orgId, userId, id);
    return rowToChat(res.rows[0]!);
  }

  async createChat(orgId: string, userId: string, title: string | null, projectId: string | null): Promise<ChatRow> {
    const id = uuidv7();
    const res = await this.pool.query<Record<string, unknown>>(
      `INSERT INTO chats (id, org_id, user_id, title, project_id, machine_id, machine_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, org_id, user_id, title,
         ${utcText("created_at")} AS created_at,
         machine_id, machine_label, generating, project_id`,
      [id, orgId, userId, title, projectId, null, null],
    );
    await notifyChatCreated(this.pool, orgId, userId, id);
    return rowToChat(res.rows[0]!);
  }

  /** Creates a chat bound to its project's machine (bind-time inheritance):
   *  the project row is locked and its machine binding read inside the same
   *  transaction as the INSERT, so a concurrent re-pair adoption can never
   *  slip a retired machine id between the read and the write. */
  async createChatForProject(orgId: string, userId: string, title: string | null, projectId: string): Promise<ChatRow> {
    return withTransaction(this.pool, async (client) => {
      const binding = await client.query<{ machine_id: string; label: string | null }>(
        `SELECT p.machine_id, coalesce(m.label, p.machine_id) AS label
         FROM projects p LEFT JOIN machines m ON m.machine_id = p.machine_id
         WHERE p.id = $1 AND p.org_id = $2 AND p.user_id = $3 FOR UPDATE OF p`,
        [projectId, orgId, userId],
      );
      const row = binding.rows[0];
      if (!row) throw ApiError.notFound("no such project");
      const id = uuidv7();
      const res = await client.query<Record<string, unknown>>(
        `INSERT INTO chats (id, org_id, user_id, title, project_id, machine_id, machine_label)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, org_id, user_id, title,
           ${utcText("created_at")} AS created_at,
           machine_id, machine_label, generating, project_id`,
        [id, orgId, userId, title, projectId, row.machine_id, row.label],
      );
      await notifyChatCreated(client, orgId, userId, id);
      return rowToChat(res.rows[0]!);
    });
  }

  async listChats(orgId: string, userId: string): Promise<ChatListRow[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      `${LIST_SELECT} WHERE c.org_id = $1 AND c.user_id = $2
       AND c.archived_at IS NULL AND c.deleted_at IS NULL
       AND ${USER_THREAD}
       ${LIST_ORDER}`,
      [orgId, userId],
    );
    return res.rows.map(rowToList);
  }

  async listArchivedChats(orgId: string, userId: string): Promise<ChatListRow[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      `${WORKING_CTE} SELECT c.id, c.org_id, c.user_id, c.title,
              ${utcText("c.created_at")} AS created_at,
              c.machine_id, c.machine_label, c.generating,
              (c.generating OR wc.chat_id IS NOT NULL) AS working, c.project_id,
              pr.name AS project_name, m.label AS project_machine_label, false AS unread,
              EXISTS (
                SELECT 1 FROM thread_events e
                WHERE e.chat_id = c.id AND e.type = 'approval_request'
                  AND e.created_at > now() - interval '10 minutes'
                  AND NOT EXISTS (
                    SELECT 1 FROM thread_events d
                    WHERE d.chat_id = e.chat_id AND d.type = 'approval_decision'
                      AND d.seq > e.seq AND d.payload->>'call_id' = e.payload->>'call_id')) AS blocked,
              ${utcText("COALESCE(le.created_at, c.created_at)")} AS last_activity_at,
              COALESCE(xt.type, 'user') AS type,
              true AS archived, false AS deleted
       FROM chats c
       LEFT JOIN agent_threads xt ON xt.chat_id = c.id
       LEFT JOIN working_chats wc ON wc.chat_id = c.id
       LEFT JOIN projects pr ON pr.id = c.project_id
       LEFT JOIN machines m ON m.machine_id = pr.machine_id
       LEFT JOIN LATERAL (
         SELECT e.created_at FROM thread_events e WHERE e.chat_id = c.id ORDER BY e.seq DESC LIMIT 1
       ) le ON true
       WHERE c.org_id = $1 AND c.user_id = $2
         AND c.archived_at IS NOT NULL AND c.deleted_at IS NULL
         AND ${USER_THREAD}
       ${LIST_ORDER}`,
      [orgId, userId],
    );
    return res.rows.map(rowToList);
  }

  /** One sidebar row by id: the shape every chat response carries. The
   *  archived and deleted filters do not apply — a write that archives or
   *  deletes a chat must return the row it changed. */
  async getChatListRow(orgId: string, userId: string, chatId: string): Promise<ChatListRow | null> {
    const res = await this.pool.query<Record<string, unknown>>(
      `${LIST_SELECT} WHERE c.org_id = $1 AND c.user_id = $2 AND c.id = $3`,
      [orgId, userId, chatId],
    );
    const row = res.rows[0];
    return row ? rowToList(row) : null;
  }

  /** The read gate: the chat's owner, or an admin of its org. Members must
   *  not read other members' threads. A deleted chat still resolves (its
   *  transcript stays reachable by link). */
  async getChat(orgId: string, chatId: string, caller: UserRow): Promise<ChatRow> {
    const isAdmin = caller.role === "admin";
    const res = await this.pool.query<Record<string, unknown>>(
      `${CHAT_ROW_SELECT} WHERE org_id = $1 AND id = $2 AND (user_id = $3 OR $4)`,
      [orgId, chatId, caller.id, isAdmin],
    );
    const row = res.rows[0];
    if (!row) throw ApiError.notFound("no such chat");
    return rowToChat(row);
  }

  /** The write gate: the caller owns the chat and it is not deleted.
   *  Renames, archiving, project binding, turns, appends, approvals and
   *  stops are the owner's alone — an admin's read access does not extend
   *  to acting inside a member's conversation. */
  async getOwnChat(orgId: string, chatId: string, caller: UserRow): Promise<ChatRow> {
    const res = await this.pool.query<Record<string, unknown>>(
      `${CHAT_ROW_SELECT} WHERE org_id = $1 AND id = $2 AND user_id = $3 AND deleted_at IS NULL`,
      [orgId, chatId, caller.id],
    );
    const row = res.rows[0];
    if (!row) throw ApiError.notFound("no such chat");
    return rowToChat(row);
  }

  /** Loads a chat by org + id without an owner check. Callers must have
   *  authorized the access themselves (agent turn routes resolve the agent
   *  grant before using the thread's chat journal). */
  async getChatInOrg(orgId: string, chatId: string): Promise<ChatRow> {
    const res = await this.pool.query<Record<string, unknown>>(
      `${CHAT_ROW_SELECT} WHERE org_id = $1 AND id = $2`,
      [orgId, chatId],
    );
    const row = res.rows[0];
    if (!row) throw ApiError.notFound("no such chat");
    return rowToChat(row);
  }

  /** Renames and/or archives the caller's own chat. `title` undefined keeps
   *  the title, null clears it. Archiving stamps archived_at and settles
   *  every waiting command as cancelled in the same transaction; the chats
   *  row lock is taken BEFORE the settle so the ordering serializes against
   *  turn acceptance. */
  async updateChat(
    orgId: string,
    chatId: string,
    caller: UserRow,
    title: string | null | undefined,
    archived: boolean | null | undefined,
  ): Promise<ChatRow> {
    const row = await withTransaction(this.pool, async (client) => {
      const locked = await client.query(
        "SELECT id FROM chats WHERE org_id = $1 AND id = $2 AND user_id = $3 AND deleted_at IS NULL FOR UPDATE",
        [orgId, chatId, caller.id],
      );
      if (locked.rowCount === 0) throw ApiError.notFound("no such chat");
      const res = await client.query<Record<string, unknown>>(
        `UPDATE chats SET title = CASE WHEN $5::bool THEN $3 ELSE title END,
           archived_at = CASE
             WHEN $4::bool IS NULL THEN archived_at
             WHEN $4::bool THEN now()
             ELSE NULL END
         WHERE org_id = $1 AND id = $2
         RETURNING id, org_id, user_id, title,
           ${utcText("created_at")} AS created_at,
           machine_id, machine_label, generating, project_id`,
        [orgId, chatId, title ?? null, archived ?? null, title !== undefined],
      );
      if (archived === true) {
        await client.query(
          "UPDATE turn_commands SET status = 'cancelled', finished_at = now() WHERE chat_id = $1 AND finished_at IS NULL AND status IN ('pending','submitted')",
          [chatId],
        );
      }
      return res.rows[0]!;
    });
    // A rename or archive moves the sidebar lists: the workspace push
    // carries the new title, or the row's move into the archived list.
    await this.pool.query("SELECT pg_notify('guild_workspace', $1)", [
      JSON.stringify({ org_id: orgId, user_id: row.user_id as string, chat_id: chatId, parts: CHAT_LIST_PARTS }),
    ]);
    return rowToChat(row);
  }

  /** Soft-deletes the caller's own chat and its agent-thread subtree. A
   *  deleted chat drops out of every list and refuses writes but keeps its
   *  row and transcript; deletion is separate from archiving and does not
   *  unarchive. One transaction closes the subtree (its queued and running
   *  runs cancel and every node gets closed_at, so deliveries stop), marks
   *  every descendant chat deleted, and settles each chat's waiting
   *  commands as cancelled. A child chat belongs to the user whose run
   *  spawned it, so that user may delete a child directly: its own subtree
   *  goes with it and its parent stays. Deleting again answers the same row
   *  and keeps the first deletion time. `descendants` names the subtree's
   *  other chats so the caller can stop their live turns. */
  async deleteChat(
    orgId: string,
    chatId: string,
    caller: UserRow,
  ): Promise<{ chat: ChatRow; descendants: string[] }> {
    const { row, descendants, users } = await withTransaction(this.pool, async (client) => {
      const res = await client.query<Record<string, unknown>>(
        `UPDATE chats SET deleted_at = COALESCE(deleted_at, now())
         WHERE org_id = $1 AND id = $2 AND user_id = $3
         RETURNING id, org_id, user_id, title,
           ${utcText("created_at")} AS created_at,
           machine_id, machine_label, generating, project_id,
           archived_at IS NOT NULL AS archived, true AS deleted,
           deleted_at = now() AS newly_deleted`,
        [orgId, chatId, caller.id],
      );
      if (res.rowCount === 0) throw ApiError.notFound("no such chat");
      const root = res.rows[0]!;
      const tree = await client.query<{ thread_id: string; chat_id: string }>(
        `WITH RECURSIVE tree AS (
           SELECT id, chat_id, 0 AS distance FROM agent_threads WHERE chat_id = $1
           UNION ALL
           SELECT child.id, child.chat_id, tree.distance + 1
           FROM agent_threads child JOIN tree ON child.parent_thread_id = tree.id
           WHERE tree.distance < 64
         )
         SELECT id AS thread_id, chat_id FROM tree`,
        [chatId],
      );
      const threadIds = tree.rows.map((r) => r.thread_id);
      const chatIds = tree.rows.map((r) => r.chat_id).filter((id) => id !== chatId);
      if (threadIds.length > 0) {
        await client.query(
          `UPDATE agent_runs SET status = 'cancelled', finished_at = now()
           WHERE thread_id = ANY($1::uuid[]) AND status IN ('queued', 'running')`,
          [threadIds],
        );
        await client.query(
          "UPDATE agent_threads SET closed_at = now() WHERE id = ANY($1::uuid[]) AND closed_at IS NULL",
          [threadIds],
        );
      }
      const marked = await client.query<{ user_id: string }>(
        "UPDATE chats SET deleted_at = now() WHERE id = ANY($1::uuid[]) AND deleted_at IS NULL RETURNING user_id",
        [chatIds],
      );
      await client.query(
        `UPDATE turn_commands SET status = 'cancelled', finished_at = now()
         WHERE chat_id = ANY($1::uuid[]) AND finished_at IS NULL AND status IN ('pending','submitted')`,
        [[chatId, ...chatIds]],
      );
      const moved = new Set(marked.rows.map((r) => r.user_id));
      if (root.newly_deleted === true) moved.add(root.user_id as string);
      return { row: root, descendants: chatIds, users: [...moved] };
    });
    // Each owner whose chat left a list gets the sidebar push.
    for (const userId of users) {
      await this.pool.query("SELECT pg_notify('guild_workspace', $1)", [
        JSON.stringify({ org_id: orgId, user_id: userId, chat_id: chatId, parts: CHAT_LIST_PARTS }),
      ]);
    }
    return { chat: rowToChat(row), descendants };
  }

  /** Sets (or clears) the chat's machine binding — only the
   *  project-alignment path calls this. The registry row is locked inside
   *  the write tx so a stale cached machine can never be reinstated over an
   *  adopted binding. */
  async setMachine(orgId: string, chatId: string, machineId: string | null, machineLabel: string | null): Promise<ChatRow> {
    return withTransaction(this.pool, async (client) => {
      if (machineId !== null) {
        const known = await client.query(
          "SELECT machine_id FROM machines WHERE machine_id = $1 AND org_id = $2 FOR UPDATE",
          [machineId, orgId],
        );
        if (known.rowCount === 0) throw ApiError.badRequest("unknown machine");
      }
      const res = await client.query<Record<string, unknown>>(
        `UPDATE chats SET machine_id = $3, machine_label = $4
         WHERE org_id = $1 AND id = $2
         RETURNING id, org_id, user_id, title,
           ${utcText("created_at")} AS created_at,
           machine_id, machine_label, generating, project_id`,
        [orgId, chatId, machineId, machineLabel],
      );
      return rowToChat(res.rows[0]!);
    });
  }

  /** Sets (or clears, with null) the caller's own chat's project; the
   *  machine binding is project-derived and rides the same UPDATE (a chat
   *  runs where its project's folder lives); clearing the project clears the
   *  machine. The project must be the caller's too. */
  async setProject(orgId: string, chatId: string, caller: UserRow, projectId: string | null): Promise<ChatRow> {
    return withTransaction(this.pool, async (client) => {
      let machine: { machine_id: string | null; label: string | null } | undefined;
      if (projectId !== null) {
        const res = await client.query<{ machine_id: string | null; label: string | null }>(
          `SELECT p.machine_id, m.label FROM projects p
           LEFT JOIN machines m ON m.machine_id = p.machine_id
           WHERE p.org_id = $1 AND p.id = $2 AND p.user_id = $3 FOR UPDATE OF p`,
          [orgId, projectId, caller.id],
        );
        machine = res.rows[0];
        if (!machine) throw ApiError.notFound("no such project");
      }
      const res = await client.query<Record<string, unknown>>(
        `UPDATE chats SET project_id = $6, machine_id = $4, machine_label = $5
         WHERE org_id = $1 AND id = $2 AND user_id = $3 AND deleted_at IS NULL
         RETURNING id, org_id, user_id, title,
           ${utcText("created_at")} AS created_at,
           machine_id, machine_label, generating, project_id`,
        [orgId, chatId, caller.id, machine?.machine_id ?? null, machine?.label ?? null, projectId],
      );
      if (res.rowCount === 0) throw ApiError.notFound("no such chat");
      return rowToChat(res.rows[0]!);
    });
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

  /** Sets (or clears, with null) the caller's own chat's approval-mode
   *  override — the composer's per-chat policy (chats.approval). */
  async setApproval(orgId: string, caller: UserRow, chatId: string, policy: Record<string, unknown> | null): Promise<void> {
    const res = await this.pool.query(
      "UPDATE chats SET approval = $4::jsonb WHERE org_id = $1 AND id = $2 AND user_id = $3 AND deleted_at IS NULL",
      [orgId, chatId, caller.id, policy === null ? null : jsonbText(policy)],
    );
    if (res.rowCount === 0) throw ApiError.notFound("no such chat");
  }

  /** The chat's approval-mode override behind the read gate (null = the
   *  account default applies). */
  async approval(orgId: string, caller: UserRow, chatId: string): Promise<{ default?: string } | null> {
    const res = await this.pool.query<{ approval: { default?: string } | null }>(
      "SELECT approval FROM chats WHERE org_id = $1 AND id = $2 AND (user_id = $3 OR $4)",
      [orgId, chatId, caller.id, caller.role === "admin"],
    );
    if (res.rows.length === 0) throw ApiError.notFound("no such chat");
    return res.rows[0]!.approval ?? null;
  }

  /** The chat's generating flag (the approval route's live-turn check). */
  async isGenerating(orgId: string, chatId: string): Promise<boolean> {
    const res = await this.pool.query<{ generating: boolean }>(
      "SELECT generating FROM chats WHERE org_id = $1 AND id = $2",
      [orgId, chatId],
    );
    return res.rows[0]?.generating ?? false;
  }

  /** Flips the generating flag. The status NOTIFY rides the same statement,
   *  so notifications reach listeners in commit order and always agree
   *  with the flag. Silent no-op when the flag already holds the value. */
  async setGenerating(orgId: string, chatId: string, generating: boolean): Promise<void> {
    await this.pool.query(
      withStatusNotify(
        `UPDATE chats SET generating = $3
         WHERE org_id = $1 AND id = $2 AND generating IS DISTINCT FROM $3
         RETURNING org_id, user_id, id, generating`,
      ),
      [orgId, chatId, generating],
    );
  }

  /** Sets the generating flag for an arriving turn and returns the value it
   *  held, under the row lock: of two concurrent arrivals exactly one sees
   *  `false`, so the other is marked queued. */
  async reserveGenerating(orgId: string, chatId: string): Promise<boolean> {
    const res = await this.pool.query<{ prior: boolean }>(
      `WITH prior AS (
         SELECT id, generating FROM chats WHERE org_id = $1 AND id = $2 FOR UPDATE
       ), flipped AS (
         UPDATE chats c SET generating = true FROM prior
         WHERE c.id = prior.id AND NOT prior.generating
         RETURNING c.org_id, c.user_id, c.id, c.generating
       ), notified AS (
         SELECT ${STATUS_NOTIFY} FROM flipped u
       )
       SELECT prior.generating AS prior, (SELECT count(*) FROM notified) AS notified FROM prior`,
      [orgId, chatId],
    );
    return res.rows[0]?.prior ?? false;
  }

  /** Reconcile the UI projection against current durable work in one SQL
   * statement, rather than clearing a flag from an earlier run's snapshot. */
  async reconcileGenerating(orgId: string, chatId: string): Promise<void> {
    await this.pool.query(
      withStatusNotify(
        `WITH work AS (
          SELECT EXISTS (SELECT 1 FROM chat_conversations c WHERE c.chat_id=$2 AND (${generationWorkSql})) AS generating
        ) UPDATE chats c SET generating=work.generating FROM work
          WHERE c.org_id=$1 AND c.id=$2 AND c.generating IS DISTINCT FROM work.generating
          RETURNING c.org_id, c.user_id, c.id, c.generating`,
      ),
      [orgId, chatId],
    );
  }

  /** Boot repair: a send that was in flight when the process stopped left
   *  the flag set with no durable work behind it, and nothing would ever
   *  clear it — the chat spins forever. Recompute every set flag against the
   *  journal once, so a restart cannot leave one behind. */
  async reconcileAllGenerating(): Promise<void> {
    await this.pool.query(
      withStatusNotify(
        `WITH work AS (
          SELECT ch.id, EXISTS (
            SELECT 1 FROM chat_conversations c WHERE c.chat_id = ch.id AND (${generationWorkSql})
          ) AS generating
          FROM chats ch WHERE ch.generating
        ) UPDATE chats c SET generating = work.generating FROM work
          WHERE c.id = work.id AND c.generating IS DISTINCT FROM work.generating
          RETURNING c.org_id, c.user_id, c.id, c.generating`,
      ),
    );
  }

  /** Fills an empty chat title with a generated name and mirrors it onto
   *  the thread. A locked or already-named thread is left alone; the first
   *  writer wins, so two queued runs cannot race a title in. */
  async setGeneratedTitle(
    orgId: string,
    chatId: string,
    threadId: string,
    title: string,
  ): Promise<void> {
    const clean = title.trim();
    if (clean === "") return;
    const ownerId = await withTransaction(this.pool, async (client) => {
      const chat = await client.query<{ user_id: string }>(
        `UPDATE chats SET title = $3
         WHERE org_id = $1 AND id = $2 AND (title IS NULL OR title = '')
         RETURNING user_id`,
        [orgId, chatId, clean],
      );
      const row = chat.rows[0];
      // An already-named chat wrote nothing: the empty transaction commits.
      if (row === undefined) return null;
      await client.query(
        `UPDATE agent_threads SET title = $3
         WHERE id = $1 AND chat_id = $2 AND title_locked = false
           AND (title IS NULL OR title = '')`,
        [threadId, chatId, clean],
      );
      return row.user_id;
    });
    if (ownerId === null) return;
    await this.pool.query("SELECT pg_notify('guild_workspace', $1)", [
      JSON.stringify({ org_id: orgId, user_id: ownerId, chat_id: chatId, parts: CHAT_LIST_PARTS }),
    ]);
  }

  /** Marks the chat read for the caller: the marker moves to the newest
   *  thread event's `seq` (migration 0066 shape — event ids cannot order
   *  events; the BIGSERIAL write order is the comparison space). The marker
   *  only ever moves forward: a read frame that arrives late, or a repeat
   *  sent after a reconnect, cannot resurrect an already-cleared dot. A chat
   *  with no events has nothing unread — no marker. */
  async markRead(orgId: string, chatId: string, caller: UserRow): Promise<void> {
    await this.getChat(orgId, chatId, caller);
    const last = await this.pool.query<{ seq: string }>(
      "SELECT seq FROM thread_events WHERE chat_id = $1 ORDER BY seq DESC LIMIT 1",
      [chatId],
    );
    const lastReadSeq = last.rows[0]?.seq;
    if (lastReadSeq === undefined) return;
    await this.pool.query(
      `INSERT INTO chat_reads (chat_id, user_id, last_read_seq) VALUES ($1, $2, $3)
       ON CONFLICT (chat_id, user_id) DO UPDATE
         SET last_read_seq = GREATEST(chat_reads.last_read_seq, EXCLUDED.last_read_seq)`,
      [chatId, caller.id, lastReadSeq],
    );
    // The marker is sidebar state: every other open client of this user
    // must clear the dot, so the read write pushes the workspace lists.
    await this.pool.query("SELECT pg_notify('guild_workspace', $1)", [
      JSON.stringify({ org_id: orgId, user_id: caller.id, chat_id: chatId, parts: CHAT_LIST_PARTS }),
    ]);
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
    working: Boolean(r.working),
    unread: Boolean(r.unread),
    blocked: Boolean(r.blocked),
    project_id: (r.project_id as string | null) ?? null,
    project_name: (r.project_name as string | null) ?? null,
    project_machine_label: (r.project_machine_label as string | null) ?? null,
    last_activity_at: pgTimestampToRfc3339(r.last_activity_at as string),
    type: ((r.type as string | null) ?? "user") as ChatListRow["type"],
    archived: Boolean(r.archived),
    deleted: Boolean(r.deleted),
  };
}
