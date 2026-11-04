// The agent thread index: each thread owns one chats row (agent_threads.
// chat_id) holding its transcript. Create (top-level, default and delegated
// child), the caller's paged thread list, lookups, rename, activity and the
// derived title.

import { ApiError } from "../../platform/errors.js";
import { withTransaction, type PlatformPool } from "../../platform/db.js";
import { uuidv7 } from "../../platform/time.js";
import type { ChatStore } from "../../platform/store/chats.js";
import type { Agent, AgentThread, AgentThreadType } from "../types.js";
import { THREAD_COLUMNS, toThread } from "./rows.js";

/** A parent thread already holds its maximum number of children. */
export class ChildLimitReached extends Error {
  constructor(
    readonly children: number,
    readonly limit: number,
  ) {
    super(`this thread already has ${children} children; the limit is ${limit} per thread`);
    this.name = "ChildLimitReached";
  }
}

/** The largest page a thread list returns. */
export const MAX_THREAD_PAGE = 100;

export type ThreadSort = "activity_desc" | "activity_asc" | "created_desc" | "created_asc";

/** The filters a thread list accepts. `archived: null` includes both the
 *  active and the archived threads; the default is active only. */
export interface ThreadListOptions {
  types?: AgentThreadType[];
  archived?: boolean | null;
  /** null includes deleted threads (the export path); default false. */
  deleted?: boolean | null;
  parentThreadId?: string;
  sort?: ThreadSort;
  limit?: number;
  cursor?: string | null;
}

/** A listed thread carries its chat's two flags: a thread row alone cannot
 *  say whether the user archived or deleted it. */
export interface ListedThread extends AgentThread {
  archived: boolean;
  deleted: boolean;
}

export interface ThreadPage {
  threads: ListedThread[];
  next_cursor: string | null;
}

function encodeThreadCursor(sort: ThreadSort, at: string, id: string): string {
  return Buffer.from(JSON.stringify({ s: sort, t: at, i: id }), "utf8").toString("base64url");
}

function decodeThreadCursor(cursor: string, sort: ThreadSort): { at: string; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      s?: unknown;
      t?: unknown;
      i?: unknown;
    };
    if (parsed.s !== sort || typeof parsed.t !== "string" || typeof parsed.i !== "string") {
      throw new Error("cursor does not match the requested sort");
    }
    return { at: parsed.t, id: parsed.i };
  } catch {
    throw ApiError.badRequest("invalid cursor");
  }
}

/** Short, markdown-stripped thread title from the first non-empty line of a
 *  user message. Never the placeholder "New chat". The desktop derives the
 *  same label for a new chat, so the two paths must stay in step. */
export function deriveTitleFromMessage(message: string): string {
  const first = message.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  const text = first
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return "";
  const maxWords = 6;
  const max = 60;
  const words = text.split(" ");
  let title = words.slice(0, maxWords).join(" ");
  let cut = words.length > maxWords;
  if (title.length > max) {
    // Cut at a word boundary and mark the cut, so a title never ends
    // mid-word without saying text was dropped.
    const stem = title.slice(0, max - 1);
    const space = stem.lastIndexOf(" ");
    title = (space >= max / 2 ? stem.slice(0, space) : stem).replace(/[\s,;:.\-–—]+$/, "");
    cut = true;
  }
  if (cut) title = `${title.replace(/[\s,;:.\-–—]+$/, "")}…`;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

export class AgentThreadStore {
  constructor(
    private readonly pool: PlatformPool,
    private readonly chats: Pick<ChatStore, "createChatOn">,
    /** The agent a new thread belongs to (its org owns the chat row). */
    private readonly fetchAgent: (agentId: string) => Promise<Agent>,
  ) {}

  /** Creates a chat journal row plus its agent_threads row in one
   *  transaction. The thread is private to `userId`; the chat journal row is
   *  owned by that user too. */
  async createThread(
    agentId: string,
    userId: string,
    title: string,
    type: AgentThreadType = "user",
    options: {
      originThreadId?: string;
      isDefault?: boolean;
      /** The routine whose output this thread is. */
      routineId?: string;
      /** This thread is the routine's feed: thread-mode deliveries append here. */
      routineFeed?: boolean;
      titleLocked?: boolean;
    } = {},
  ): Promise<AgentThread> {
    const agent = await this.fetchAgent(agentId);
    const id = uuidv7();
    await withTransaction(this.pool, async (client) => {
      const chat = await this.chats.createChatOn(
        client,
        agent.org_id,
        userId,
        title.trim() === "" ? null : title,
        null,
      );
      await client.query(
        `INSERT INTO agent_threads
           (id, agent_id, user_id, chat_id, title, title_locked, type, is_default, origin_thread_id,
            routine_id, routine_feed)
         VALUES ($1, $2, $3, $4, $5, $9, $6, $7, $8, $10, $11)`,
        [
          id,
          agentId,
          userId,
          chat.id,
          title,
          type,
          options.isDefault === true,
          options.originThreadId ?? null,
          options.titleLocked === true,
          options.routineId ?? null,
          options.routineFeed === true,
        ],
      );
    });
    return this.getThread(agentId, userId, id);
  }

  /** Creates a delegated child thread under an existing node. The edge is
   *  parent_thread_id; depth is the parent's depth plus one. With
   *  `maxChildren`, the parent row is locked for the count and the insert, so
   *  concurrent spawns under one parent never exceed the limit. */
  async createChildThread(
    parentThreadId: string,
    agentId: string,
    userId: string,
    title: string,
    titleLocked = false,
    maxChildren?: number,
  ): Promise<AgentThread> {
    const agent = await this.fetchAgent(agentId);
    const id = uuidv7();
    await withTransaction(this.pool, async (client) => {
      const parent = await client.query<{ depth: number; closed_at: Date | null }>(
        "SELECT depth, closed_at FROM agent_threads WHERE id = $1 FOR UPDATE",
        [parentThreadId],
      );
      const parentRow = parent.rows[0];
      if (parentRow === undefined) throw ApiError.notFound("no such parent thread");
      if (parentRow.closed_at !== null) throw ApiError.badRequest("the parent thread is closed");
      if (maxChildren !== undefined) {
        const count = await client.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM agent_threads WHERE parent_thread_id = $1",
          [parentThreadId],
        );
        const children = Number(count.rows[0]?.count ?? 0);
        if (children >= maxChildren) throw new ChildLimitReached(children, maxChildren);
      }
      const chat = await this.chats.createChatOn(
        client,
        agent.org_id,
        userId,
        title.trim() === "" ? null : title,
        null,
      );
      await client.query(
        `INSERT INTO agent_threads
           (id, agent_id, user_id, chat_id, title, title_locked, type, parent_thread_id, depth)
         VALUES ($1, $2, $3, $4, $5, $8, 'subagent', $6, $7)`,
        [id, agentId, userId, chat.id, title, parentThreadId, Number(parentRow.depth) + 1, titleLocked],
      );
    });
    return this.getThread(agentId, userId, id);
  }

  /** The user's Main thread with this agent, when they have one. */
  async mainThread(agentId: string, userId: string): Promise<AgentThread | null> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${THREAD_COLUMNS} FROM agent_threads t
       WHERE t.agent_id = $1 AND t.user_id = $2 AND t.is_default`,
      [agentId, userId],
    );
    const row = res.rows[0];
    return row === undefined ? null : toThread(row);
  }

  /** One page of the caller's threads with this agent. Type, archive and
   *  deletion are independent filters. A cursor is opaque: it carries the
   *  sort key of the last returned row, so a page boundary never skips or
   *  repeats a row. */
  async listThreads(agentId: string, userId: string, options: ThreadListOptions = {}): Promise<ThreadPage> {
    const types = options.types ?? ["user"];
    const sort = options.sort ?? "activity_desc";
    const limit = Math.max(1, Math.min(MAX_THREAD_PAGE, Math.floor(options.limit ?? 20)));
    const params: unknown[] = [agentId, userId, types];
    const where = ["t.agent_id = $1", "t.user_id = $2", "t.type = ANY($3::text[])"];
    if (options.archived === true) where.push("c.archived_at IS NOT NULL");
    else if (options.archived === false) where.push("c.archived_at IS NULL");
    if (options.deleted === true) where.push("c.deleted_at IS NOT NULL");
    else if (options.deleted !== null) where.push("c.deleted_at IS NULL");
    if (options.parentThreadId !== undefined) {
      params.push(options.parentThreadId);
      where.push(`t.parent_thread_id = $${params.length}`);
    }
    const column = sort.startsWith("created") ? "t.created_at" : "t.last_activity_at";
    const descending = sort.endsWith("_desc");
    const cursor =
      options.cursor === undefined || options.cursor === null ? null : decodeThreadCursor(options.cursor, sort);
    if (cursor !== null) {
      params.push(cursor.at, cursor.id);
      where.push(
        `(${column}, t.id) ${descending ? "<" : ">"} ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
      );
    }
    params.push(limit + 1);
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${THREAD_COLUMNS},
              c.archived_at IS NOT NULL AS archived, c.deleted_at IS NOT NULL AS deleted
       FROM agent_threads t
       JOIN chats c ON c.id = t.chat_id
       WHERE ${where.join(" AND ")}
       ORDER BY ${column} ${descending ? "DESC" : "ASC"}, t.id ${descending ? "DESC" : "ASC"}
       LIMIT $${params.length}`,
      params,
    );
    const rows = res.rows.slice(0, limit).map((row) => ({
      ...toThread(row),
      archived: Boolean(row.archived),
      deleted: Boolean(row.deleted),
    }));
    const last = rows[rows.length - 1];
    const more = res.rows.length > limit;
    return {
      threads: rows,
      next_cursor:
        more && last !== undefined
          ? encodeThreadCursor(sort, sort.startsWith("created") ? last.created_at : last.last_activity_at, last.id)
          : null,
    };
  }

  /** One of the caller's threads with this agent; 404 otherwise. */
  async getThread(agentId: string, userId: string, threadId: string): Promise<AgentThread> {
    const thread = await this.findThread(agentId, userId, threadId);
    if (thread === null) throw ApiError.notFound("no such thread");
    return thread;
  }

  /** One of the caller's threads with this agent; null for another agent's
   *  or another user's thread as for a missing one. */
  async findThread(agentId: string, userId: string, threadId: string): Promise<AgentThread | null> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${THREAD_COLUMNS} FROM agent_threads t
       WHERE t.agent_id = $1 AND t.user_id = $2 AND t.id = $3`,
      [agentId, userId, threadId],
    );
    const row = res.rows[0];
    return row === undefined ? null : toThread(row);
  }

  /** The newest thread of this agent and user with this title and origin
   *  opened within the last minute, if any: a repeated send_message lands
   *  in the thread it already opened. */
  async recentlyOpened(
    agentId: string,
    userId: string,
    title: string,
    originThreadId: string | null,
  ): Promise<{ id: string; chat_id: string } | null> {
    const res = await this.pool.query<{ id: string; chat_id: string }>(
      `SELECT id, chat_id FROM agent_threads
       WHERE agent_id = $1 AND user_id = $2 AND title = $3
         AND origin_thread_id IS NOT DISTINCT FROM $4::uuid
         AND created_at > now() - interval '1 minute'
       ORDER BY created_at DESC LIMIT 1`,
      [agentId, userId, title, originThreadId],
    );
    return res.rows[0] ?? null;
  }

  /** The routine behind a routine run thread: the routine of the thread's
   *  newest run. Null for any other thread, or when the routine is gone. */
  async routineOfRunThread(
    threadId: string,
  ): Promise<{ id: string; name: string; delivery: "thread" | "new_chat" } | null> {
    const res = await this.pool.query<{ id: string; name: string; delivery: string }>(
      `SELECT r.id, r.name, r.delivery
       FROM agent_threads t
       JOIN LATERAL (
         SELECT rn.routine_id FROM agent_runs rn
         WHERE rn.thread_id = t.id AND rn.routine_id IS NOT NULL
         ORDER BY rn.created_at DESC LIMIT 1
       ) lr ON true
       JOIN agent_routines r ON r.id = lr.routine_id
       WHERE t.id = $1 AND t.type = 'routine'`,
      [threadId],
    );
    const row = res.rows[0];
    if (row === undefined) return null;
    return { id: row.id, name: row.name, delivery: row.delivery === "new_chat" ? "new_chat" : "thread" };
  }

  /** The routine's live feed thread for this user and agent. A feed whose
   *  chat was archived or deleted, or whose thread was closed, is retired
   *  here (it stays a routine-output thread, no longer the feed) and null
   *  is returned. */
  async routineFeed(
    agentId: string,
    userId: string,
    routineId: string,
  ): Promise<{ id: string; chat_id: string; generating: boolean } | null> {
    const res = await this.pool.query<{ id: string; chat_id: string; generating: boolean; live: boolean }>(
      `SELECT t.id, t.chat_id, c.generating,
              (c.archived_at IS NULL AND c.deleted_at IS NULL AND t.closed_at IS NULL
               AND t.agent_id = $1) AS live
       FROM agent_threads t JOIN chats c ON c.id = t.chat_id
       WHERE t.routine_id = $3 AND t.user_id = $2 AND t.routine_feed`,
      [agentId, userId, routineId],
    );
    const row = res.rows[0];
    if (row === undefined) return null;
    if (!row.live) {
      await this.pool.query("UPDATE agent_threads SET routine_feed = false WHERE id = $1", [row.id]);
      return null;
    }
    return { id: row.id, chat_id: row.chat_id, generating: row.generating };
  }

  /** The chat a routine run's send_message landed in: the routine's feed, or
   *  the chat the run opened in new_chat mode. Null when this run sent
   *  nothing — the newest delivery into a feed carries that run's origin. */
  async routineDeliveryChat(runThreadId: string): Promise<{ chat_id: string; title: string } | null> {
    const res = await this.pool.query<{ chat_id: string; title: string }>(
      `SELECT d.chat_id, COALESCE(NULLIF(d.title, ''), r.name) AS title
       FROM agent_threads t
       JOIN LATERAL (
         SELECT rn.routine_id FROM agent_runs rn
         WHERE rn.thread_id = t.id AND rn.routine_id IS NOT NULL
         ORDER BY rn.created_at DESC LIMIT 1
       ) lr ON true
       JOIN agent_routines r ON r.id = lr.routine_id
       JOIN agent_threads d ON d.routine_id = r.id AND d.user_id = t.user_id
         AND d.origin_thread_id = t.id AND d.closed_at IS NULL
       WHERE t.id = $1 AND t.type = 'routine'
       ORDER BY d.created_at DESC LIMIT 1`,
      [runThreadId],
    );
    return res.rows[0] ?? null;
  }

  /** Points a routine feed at the run thread behind its newest message. */
  async setOrigin(threadId: string, originThreadId: string): Promise<void> {
    await this.pool.query("UPDATE agent_threads SET origin_thread_id = $2 WHERE id = $1", [threadId, originThreadId]);
  }

  /** One thread row by id without caller scoping. Tree tools resolve a child
   *  by id and check the parent edge themselves. */
  async threadById(threadId: string): Promise<AgentThread | null> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${THREAD_COLUMNS} FROM agent_threads t WHERE t.id = $1`,
      [threadId],
    );
    const row = res.rows[0];
    return row === undefined ? null : toThread(row);
  }

  /** One thread row by its chat, without caller scoping: the thread routes
   *  authorize the chat first and then act on the thread behind it. */
  async threadByChatId(chatId: string): Promise<AgentThread | null> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${THREAD_COLUMNS} FROM agent_threads t WHERE t.chat_id = $1`,
      [chatId],
    );
    const row = res.rows[0];
    return row === undefined ? null : toThread(row);
  }

  /** Renames a thread and locks the title against regeneration. */
  async renameThread(agentId: string, userId: string, threadId: string, title: string): Promise<AgentThread> {
    await withTransaction(this.pool, async (client) => {
      const res = await client.query<{ chat_id: string }>(
        `UPDATE agent_threads SET title = $4, title_locked = true
         WHERE agent_id = $1 AND user_id = $2 AND id = $3 RETURNING chat_id`,
        [agentId, userId, threadId, title],
      );
      const row = res.rows[0];
      if (row === undefined) throw ApiError.notFound("no such thread");
      await client.query("UPDATE chats SET title = $2 WHERE id = $1", [row.chat_id, title]);
    });
    return this.getThread(agentId, userId, threadId);
  }

  /** Moves the thread's activity marker (called when a turn commits). */
  async touchThread(agentId: string, threadId: string): Promise<void> {
    await this.pool.query("UPDATE agent_threads SET last_activity_at = now() WHERE agent_id = $1 AND id = $2", [
      agentId,
      threadId,
    ]);
  }

  /** Fills an empty, unlocked thread title from the first user message and
   *  mirrors it onto the chat journal row. A manual rename locks the title
   *  and wins over this path. */
  async deriveThreadTitle(agentId: string, threadId: string, message: string): Promise<void> {
    const title = deriveTitleFromMessage(message);
    if (title === "") return;
    await withTransaction(this.pool, async (client) => {
      const res = await client.query<{ chat_id: string }>(
        `UPDATE agent_threads SET title = $3
         WHERE agent_id = $1 AND id = $2 AND title = '' AND title_locked = false
         RETURNING chat_id`,
        [agentId, threadId, title],
      );
      const row = res.rows[0];
      if (row !== undefined) {
        await client.query("UPDATE chats SET title = $2 WHERE id = $1", [row.chat_id, title]);
      }
    });
  }
}
