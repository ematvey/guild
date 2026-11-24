// Conversation history read model: the org's chats as managers browse them.
// A conversation is one chat's journal; a run is one agent turn inside it.
// The list joins the chat, its owner, its agent thread and the run and
// message counts. The detail reads one page of message events plus the runs
// that overlap the page and groups them into the items the reader renders:
// a trigger message, the run it started, and the agent's reply.

import type {
  ConversationItem,
  ConversationMessageRow,
  ConversationRow,
  ConversationRunRow,
  ConversationThread,
} from "@guild/wire/rest";
import { canReadOwned, ownerScope, readsWholeOrg } from "../domain/access.js";
import type { UserRow } from "./identity.js";
import { threadEventText } from "../domain/thread-events.js";
import type { PlatformPool } from "../db.js";
import { pgTimestampToRfc3339, utcText } from "../time.js";

/** The event types a conversation reader shows. Tool results stay inside
 *  the run detail; the conversation is the message-level story. */
const MESSAGE_TYPES =
  "('user_message','assistant_message','system_message','turn_error','compaction','child_spawned','child_result','child_closed')";

export type { ConversationRow } from "@guild/wire/rest";

const RUN_COUNTS = `SELECT count(*)::int AS runs,
  count(*) FILTER (WHERE r.status IN ('queued','running'))::int AS open_runs,
  count(*) FILTER (WHERE r.status = 'failed')::int AS failed_runs
  FROM agent_runs r`;

export interface ConversationFilters {
  includeBackground?: boolean;
  orgId: string;
  /** When set, only this owner's conversations (a member's own history). */
  userId?: string;
  from?: Date;
  to?: Date;
  agentId?: string;
  query?: string;
  limit: number;
  offset: number;
}

const CLIP = 8_000;

function clip(text: string, max = CLIP): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** The assistant text blocks of one stored message, joined. */
function assistantText(payload: Record<string, unknown>): string {
  if (typeof payload["content"] === "string") return payload["content"];
  const blocks = Array.isArray(payload["blocks"]) ? (payload["blocks"] as { type?: string; text?: string }[]) : [];
  return blocks
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text!)
    .join("\n\n");
}

function messageRow(row: {
  seq: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: string;
}): ConversationMessageRow | null {
  const payload = row.payload ?? {};
  const ts = pgTimestampToRfc3339(row.created_at);
  const seq = Number(row.seq);
  switch (row.type) {
    case "user_message":
      return { seq, role: "user", text: clip(String(payload["content"] ?? "")), ts };
    case "assistant_message": {
      const text = assistantText(payload);
      return text.trim() === "" ? null : { seq, role: "assistant", text: clip(text), ts };
    }
    case "system_message":
      return { seq, role: "system", text: clip(String(payload["content"] ?? "")), ts };
    case "turn_error":
      return { seq, role: "error", text: clip(String(payload["message"] ?? "")), ts };
    case "compaction":
      return { seq, role: "compaction", text: clip(String(payload["summary"] ?? "")), ts };
    // A child turn, result or close is in the agent's conversation as a
    // message; the reader shows it as a system line.
    case "child_spawned":
    case "child_result":
    case "child_closed":
      return { seq, role: "system", text: clip(threadEventText(row.type, payload)), ts };
    default:
      return null;
  }
}

/** Groups one page of messages and the runs that overlap it into reading
 *  order. Each run claims the user message that precedes its start and the
 *  assistant messages inside its window; the rest stay standalone. */
/** How far after a run start its trigger message may land: the run row and
 *  the journal write happen in the same turn, in either order. */
const TRIGGER_RACE_MS = 2000;

export function groupConversation(
  messages: ConversationMessageRow[],
  runs: ConversationRunRow[],
  stepsOf: (runId: string) => { call_count: number; tool_count: number },
): ConversationItem[] {
  const claimed = new Set<number>();
  const items: ConversationItem[] = [];
  const ordered = [...runs].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
  for (const run of ordered) {
    const start = Date.parse(run.started_at);
    const end = run.finished_at === null ? Number.POSITIVE_INFINITY : Date.parse(run.finished_at);
    // The trigger is the newest user message before the run. Earlier ones
    // stay standalone: the reader sees both.
    let trigger: string | null = null;
    let triggerSeq: number | null = null;
    for (const message of messages) {
      if (message.role !== "user" || claimed.has(message.seq)) continue;
      if (Date.parse(message.ts) > start) break;
      trigger = message.text;
      triggerSeq = message.seq;
    }
    // The run row can be written a few milliseconds before the journal
    // records the message that started it (same turn). Take the first user
    // message just after the start, before a steering message can land.
    if (triggerSeq === null) {
      for (const message of messages) {
        if (message.role !== "user" || claimed.has(message.seq)) continue;
        const at = Date.parse(message.ts);
        if (at < start) continue;
        if (at > start + TRIGGER_RACE_MS) break;
        trigger = message.text;
        triggerSeq = message.seq;
        break;
      }
    }
    // The trigger stays a message of its own: it reads before the reply,
    // and the run row that names it reads after.
    let reply = false;
    let lastReplyAt = 0;
    for (const message of messages) {
      if (message.role !== "assistant" || claimed.has(message.seq)) continue;
      const at = Date.parse(message.ts);
      if (at >= start && at <= end) {
        claimed.add(message.seq);
        reply = true;
        lastReplyAt = Math.max(lastReplyAt, at);
      }
    }
    // The run row is a footnote to the turn: it reads under the agent's
    // last message, not above the first. A run still open sits at its
    // start so it stays visible while the reply streams in.
    const ts = run.finished_at ?? (lastReplyAt > 0 ? new Date(lastReplyAt).toISOString() : run.started_at);
    const counts = stepsOf(run.id);
    items.push({
      kind: "run",
      ts,
      run,
      trigger,
      steps: counts.call_count + counts.tool_count,
      ...counts,
      reply,
    });
  }
  for (const message of messages) {
    // A claimed user message is the run's trigger and already renders with
    // it. A claimed assistant message is still the agent's reply, and the
    // run row's timestamp follows it.
    if (message.role === "user" && claimed.has(message.seq)) continue;
    items.push({ kind: "message", ...message });
  }
  // Stable reading order: by timestamp, messages before the run they start.
  items.sort((a, b) => {
    const delta = Date.parse(a.ts) - Date.parse(b.ts);
    if (delta !== 0) return delta;
    return (a.kind === "message" ? 0 : 1) - (b.kind === "message" ? 0 : 1);
  });
  return items;
}

export class ConversationHistoryStore {
  constructor(private readonly pool: PlatformPool) {}

  /** The org's internal chats: coordinator and reflection histories. */
  async internalChatIds(orgId: string): Promise<string[]> {
    const res = await this.pool.query<{ id: string }>(`SELECT id FROM chats WHERE org_id=$1 AND internal`, [orgId]);
    return res.rows.map(({ id }) => id);
  }

  /** The org's conversations, newest activity first. Admin scope has no
   *  owner filter; a member reads only their own rows. */
  async list(filter: ConversationFilters): Promise<{ rows: ConversationRow[]; total: number }> {
    const params: unknown[] = [filter.orgId];
    const where: string[] = ["c.org_id = $1", "c.deleted_at IS NULL"];
    if (!filter.includeBackground) where.push("NOT c.internal");
    if (filter.userId !== undefined) {
      params.push(filter.userId);
      where.push(`c.user_id = $${params.length}`);
    }
    if (filter.agentId !== undefined) {
      params.push(filter.agentId);
      where.push(`xt.agent_id = $${params.length}`);
    }
    if (filter.from !== undefined) {
      params.push(filter.from);
      where.push(`COALESCE(le.created_at, c.created_at) >= $${params.length}::timestamptz`);
    }
    if (filter.to !== undefined) {
      params.push(filter.to);
      where.push(`COALESCE(le.created_at, c.created_at) <= $${params.length}::timestamptz`);
    }
    if (filter.query !== undefined && filter.query !== "") {
      params.push(`%${filter.query}%`);
      where.push(
        `(c.title ILIKE $${params.length} OR u.display_name ILIKE $${params.length} OR u.email ILIKE $${params.length} OR a.name ILIKE $${params.length})`,
      );
    }
    const predicate = where.join(" AND ");
    const totalRes = await this.pool.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM chats c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN agent_threads xt ON xt.chat_id = c.id
       LEFT JOIN agents a ON a.id = xt.agent_id
       LEFT JOIN LATERAL (
         SELECT e.created_at FROM thread_events e WHERE e.chat_id = c.id ORDER BY e.seq DESC LIMIT 1
       ) le ON true
       WHERE ${predicate}`,
      params,
    );
    params.push(filter.limit, filter.offset);
    const rows = await this.pool.query<Record<string, unknown>>(
      `SELECT c.id, c.title, c.internal, ${utcText("c.created_at")} AS created_at,
              c.user_id, u.email, u.display_name,
              c.archived_at IS NOT NULL AS archived, c.deleted_at IS NOT NULL AS deleted,
              xt.id AS thread_id, xt.type AS thread_type,
              xt.parent_thread_id, pt.chat_id AS parent_chat_id, pt.title AS parent_title,
              xt.agent_id, a.name AS agent_name,
              ${utcText("COALESCE(le.created_at, c.created_at)")} AS last_activity_at,
              COALESCE(msg.messages, 0) AS messages,
              COALESCE(runs.runs, 0) AS runs,
              COALESCE(runs.open_runs, 0) AS open_runs,
              COALESCE(runs.failed_runs, 0) AS failed_runs
       FROM chats c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN agent_threads xt ON xt.chat_id = c.id
       LEFT JOIN agent_threads pt ON pt.id = xt.parent_thread_id AND pt.execution_role <> 'coordinator'
       LEFT JOIN agents a ON a.id = xt.agent_id
       LEFT JOIN LATERAL (
         SELECT e.created_at FROM thread_events e WHERE e.chat_id = c.id ORDER BY e.seq DESC LIMIT 1
       ) le ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS messages FROM thread_events e
         WHERE e.chat_id = c.id AND e.type IN ('user_message','assistant_message')
       ) msg ON true
       LEFT JOIN LATERAL (
         ${RUN_COUNTS} WHERE r.thread_id = xt.id
       ) runs ON true
       WHERE ${predicate}
       ORDER BY COALESCE(le.created_at, c.created_at) DESC, c.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return {
      rows: rows.rows.map(rowToConversation),
      total: Number(totalRes.rows[0]?.total ?? 0),
    };
  }

  /** One conversation's header by id, without an access check. */
  async header(orgId: string, chatId: string, includeBackground = false): Promise<ConversationRow | null> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT c.id, c.title, c.internal, ${utcText("c.created_at")} AS created_at,
              c.user_id, u.email, u.display_name,
              c.archived_at IS NOT NULL AS archived, c.deleted_at IS NOT NULL AS deleted,
              xt.id AS thread_id, xt.type AS thread_type,
              xt.parent_thread_id, pt.chat_id AS parent_chat_id, pt.title AS parent_title,
              xt.agent_id, a.name AS agent_name,
              ${utcText("COALESCE(le.created_at, c.created_at)")} AS last_activity_at,
              COALESCE(msg.messages, 0) AS messages,
              COALESCE(runs.runs, 0) AS runs,
              COALESCE(runs.open_runs, 0) AS open_runs,
              COALESCE(runs.failed_runs, 0) AS failed_runs
       FROM chats c
       JOIN users u ON u.id = c.user_id
       LEFT JOIN agent_threads xt ON xt.chat_id = c.id
       LEFT JOIN agent_threads pt ON pt.id = xt.parent_thread_id AND ($3 OR pt.execution_role <> 'coordinator')
       LEFT JOIN agents a ON a.id = xt.agent_id
       LEFT JOIN LATERAL (
         SELECT e.created_at FROM thread_events e WHERE e.chat_id = c.id ORDER BY e.seq DESC LIMIT 1
       ) le ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS messages FROM thread_events e
         WHERE e.chat_id = c.id AND e.type IN ('user_message','assistant_message')
       ) msg ON true
       LEFT JOIN LATERAL (
         ${RUN_COUNTS} WHERE r.thread_id = xt.id
       ) runs ON true
       WHERE c.org_id = $1 AND c.id = $2 AND ($3 OR NOT c.internal)`,
      [orgId, chatId, includeBackground],
    );
    const row = res.rows[0];
    return row === undefined ? null : rowToConversation(row);
  }

  async watchedChatsOwnedBy(orgId: string, ownerId: string, watchedIds: readonly string[]): Promise<string[]> {
    const result = await this.pool.query<{ id: string }>(
      "SELECT id FROM chats WHERE org_id=$1 AND user_id=$2 AND id=ANY($3::uuid[])",
      [orgId, ownerId, watchedIds],
    );
    return result.rows.map(({ id }) => id);
  }

  async runCounts(threadId: string): Promise<Pick<ConversationRow, "runs" | "open_runs" | "failed_runs">> {
    const result = await this.pool.query<Pick<ConversationRow, "runs" | "open_runs" | "failed_runs">>(
      `${RUN_COUNTS} WHERE r.thread_id = $1`,
      [threadId],
    );
    return result.rows[0]!;
  }

  /** One page of a conversation's message events, oldest first, plus the
   *  runs that overlap the page. */
  async detail(user: UserRow, chatId: string, opts: { beforeSeq?: number; limit: number }) {
    const header = await this.header(user.org_id, chatId, readsWholeOrg(user));
    if (header === null || !canReadOwned(user, header.owner.id)) return null;
    const res = await this.pool.query<{
      seq: string;
      type: string;
      payload: Record<string, unknown>;
      created_at: string;
    }>(
      `SELECT e.seq, e.type, e.payload, ${utcText("e.created_at")} AS created_at
       FROM thread_events e
       WHERE e.chat_id = $1 AND e.type IN ${MESSAGE_TYPES}
         AND ($2::bigint IS NULL OR e.seq < $2::bigint)
       ORDER BY e.seq DESC LIMIT $3`,
      [chatId, opts.beforeSeq ?? null, opts.limit + 1],
    );
    const hasMore = res.rows.length > opts.limit;
    const page = (hasMore ? res.rows.slice(0, opts.limit) : res.rows).reverse();
    const messages = page.map(messageRow).filter((row): row is ConversationMessageRow => row !== null);
    const oldest = messages[0]?.ts ?? (page[0] === undefined ? null : pgTimestampToRfc3339(page[0].created_at));
    const runsRes = await this.pool.query<Record<string, unknown>>(
      `SELECT r.id, r.agent_id, a.name AS agent_name, r.trigger, r.status,
              r.summary, r.error_message, r.tokens,
              ${utcText("COALESCE(r.started_at, r.created_at)")} AS started_at,
              ${utcText("r.finished_at")} AS finished_at
       FROM agent_runs r
       JOIN agent_threads t ON t.id = r.thread_id
       JOIN agents a ON a.id = r.agent_id
       WHERE t.chat_id = $1
         AND ($2::timestamptz IS NULL OR COALESCE(r.finished_at, now()) >= $2::timestamptz)
       ORDER BY COALESCE(r.started_at, r.created_at) ASC, r.id ASC`,
      [chatId, oldest],
    );
    const relatedThreads =
      opts.beforeSeq === undefined ? await this.relatedThreads(user.org_id, chatId, ownerScope(user)) : [];
    return { header, messages, runs: runsRes.rows.map(rowToRun), hasMore, relatedThreads };
  }

  async relatedThreads(orgId: string, chatId: string, owner: string | undefined) {
    const { rows } = await this.pool.query<{ id: string; title: string | null; internal: boolean }>(
      `SELECT c.id, c.title, c.internal
       FROM agent_threads source
       JOIN agent_threads t ON (
         t.parent_thread_id = source.id
         OR ($3::uuid IS NULL AND t.agent_id = source.agent_id AND t.execution_role IN ('coordinator', 'reflection'))
       )
       JOIN chats c ON c.id = t.chat_id
       WHERE source.chat_id = $2 AND c.org_id = $1 AND c.id <> $2 AND c.deleted_at IS NULL
         AND ($3::uuid IS NULL OR (NOT c.internal AND c.user_id = $3))
       ORDER BY (t.execution_role = 'coordinator') DESC, (t.parent_thread_id = source.id) DESC NULLS LAST,
         c.created_at DESC, c.id
       LIMIT 40`,
      [orgId, chatId, owner ?? null],
    );
    return rows;
  }

  /** The thread a run belongs to, with its parent thread's chat. */
  async threadOfRun(orgId: string, threadId: string, includeBackground = false): Promise<ConversationThread | null> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT t.id, t.chat_id, t.type, t.parent_thread_id, pt.chat_id AS parent_chat_id, pt.title AS parent_title
       FROM agent_threads t
       JOIN chats c ON c.id = t.chat_id
       LEFT JOIN agent_threads pt ON pt.id = t.parent_thread_id AND pt.execution_role <> 'coordinator'
       WHERE c.org_id = $1 AND t.id = $2 AND ($3 OR NOT c.internal)`,
      [orgId, threadId, includeBackground],
    );
    const row = res.rows[0];
    if (row === undefined) return null;
    return {
      id: String(row["id"]),
      chat_id: String(row["chat_id"]),
      type: String(row["type"] ?? "user"),
      parent_thread_id: row["parent_thread_id"] === null ? null : String(row["parent_thread_id"]),
      parent_chat_id:
        row["parent_chat_id"] === null || row["parent_chat_id"] === undefined ? null : String(row["parent_chat_id"]),
      parent_title:
        row["parent_title"] === null || row["parent_title"] === undefined ? null : String(row["parent_title"]),
    };
  }
}

function rowToConversation(row: Record<string, unknown>): ConversationRow {
  const threadId = row["thread_id"];
  return {
    id: String(row["id"]),
    internal: row["internal"] === true,
    title: row["title"] === null || row["title"] === undefined ? null : String(row["title"]),
    owner: {
      id: String(row["user_id"]),
      email: String(row["email"] ?? ""),
      display_name:
        row["display_name"] === null || row["display_name"] === undefined ? null : String(row["display_name"]),
    },
    agent:
      row["agent_id"] === null || row["agent_id"] === undefined
        ? null
        : { id: String(row["agent_id"]), name: String(row["agent_name"] ?? "") },
    thread:
      threadId === null || threadId === undefined
        ? null
        : {
            id: String(threadId),
            chat_id: String(row["id"]),
            type: String(row["thread_type"] ?? "user"),
            parent_thread_id:
              row["parent_thread_id"] === null || row["parent_thread_id"] === undefined
                ? null
                : String(row["parent_thread_id"]),
            parent_chat_id:
              row["parent_chat_id"] === null || row["parent_chat_id"] === undefined
                ? null
                : String(row["parent_chat_id"]),
            parent_title:
              row["parent_title"] === null || row["parent_title"] === undefined ? null : String(row["parent_title"]),
          },
    created_at: pgTimestampToRfc3339(String(row["created_at"])),
    last_activity_at: pgTimestampToRfc3339(String(row["last_activity_at"])),
    messages: Number(row["messages"] ?? 0),
    runs: Number(row["runs"] ?? 0),
    open_runs: Number(row["open_runs"] ?? 0),
    failed_runs: Number(row["failed_runs"] ?? 0),
    archived: Boolean(row["archived"]),
    deleted: Boolean(row["deleted"]),
  };
}

function rowToRun(row: Record<string, unknown>): ConversationRunRow {
  return {
    id: String(row["id"]),
    agent_id: String(row["agent_id"]),
    agent_name: String(row["agent_name"] ?? ""),
    trigger: String(row["trigger"] ?? ""),
    status: String(row["status"] ?? ""),
    summary: String(row["summary"] ?? ""),
    error_message: String(row["error_message"] ?? ""),
    tokens: Number(row["tokens"] ?? 0),
    started_at: pgTimestampToRfc3339(String(row["started_at"])),
    finished_at:
      row["finished_at"] === null || row["finished_at"] === undefined
        ? null
        : pgTimestampToRfc3339(String(row["finished_at"])),
  };
}
