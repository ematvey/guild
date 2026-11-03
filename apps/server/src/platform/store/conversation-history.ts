// Conversation history read model: the org's chats as managers browse them.
// A conversation is one chat's journal; a run is one agent turn inside it.
// The list joins the chat, its owner, its agent thread and the run and
// message counts. The detail reads one page of message events plus the runs
// that overlap the page and groups them into the items the reader renders:
// a trigger message, the run it started, and the agent's reply.

import type { PlatformPool } from "../db.js";
import { pgTimestampToRfc3339, utcText } from "../time.js";

/** The event types a conversation reader shows. Tool results stay inside
 *  the run detail; the conversation is the message-level story. */
const MESSAGE_TYPES = "('user_message','assistant_message','system_message','turn_error','compaction')";

export interface ConversationOwner {
  id: string;
  email: string;
  display_name: string | null;
}

export interface ConversationAgent {
  id: string;
  name: string;
}

export interface ConversationThread {
  id: string;
  type: string;
  parent_thread_id: string | null;
  parent_chat_id: string | null;
  parent_title: string | null;
}

export interface ConversationRow {
  id: string;
  title: string | null;
  owner: ConversationOwner;
  agent: ConversationAgent | null;
  thread: ConversationThread | null;
  created_at: string;
  last_activity_at: string;
  messages: number;
  runs: number;
  open_runs: number;
  failed_runs: number;
  archived: boolean;
  deleted: boolean;
}

export interface ConversationFilters {
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

export interface ConversationRunRow {
  id: string;
  agent_id: string;
  agent_name: string;
  trigger: string;
  status: string;
  summary: string;
  error_message: string;
  tokens: number;
  started_at: string;
  finished_at: string | null;
}

export interface ConversationMessageRow {
  seq: number;
  role: "user" | "assistant" | "system" | "error" | "compaction";
  text: string;
  ts: string;
}

export interface ConversationRunItem {
  kind: "run";
  ts: string;
  run: ConversationRunRow;
  /** The user message that started the run, when the page holds it. */
  trigger: string | null;
  /** Model and tool calls in the run, from the trace store. */
  steps: number;
  call_count: number;
  tool_count: number;
}

export type ConversationItem = ({ kind: "message"; ts: string } & ConversationMessageRow) | ConversationRunItem;

export interface ConversationDetail {
  conversation: ConversationRow;
  items: ConversationItem[];
  /** True when an older page of messages exists. */
  has_more: boolean;
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
    default:
      return null;
  }
}

/** Groups one page of messages and the runs that overlap it into reading
 *  order. Each run claims the user message that precedes its start and the
 *  assistant messages inside its window; the rest stay standalone. */
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
    let trigger: string | null = null;
    for (const message of messages) {
      if (message.role !== "user" || claimed.has(message.seq)) continue;
      if (Date.parse(message.ts) > start) break;
      trigger = message.text;
      claimed.add(message.seq);
    }
    for (const message of messages) {
      if (message.role !== "assistant" || claimed.has(message.seq)) continue;
      const at = Date.parse(message.ts);
      if (at >= start && at <= end) claimed.add(message.seq);
    }
    const counts = stepsOf(run.id);
    items.push({
      kind: "run",
      ts: run.started_at,
      run,
      trigger,
      steps: counts.call_count + counts.tool_count,
      ...counts,
    });
  }
  for (const message of messages) {
    // A claimed user message is the run's trigger and already renders with
    // it. A claimed assistant message is still the agent's reply: the run
    // row starts before it, so the timestamp order places it after.
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

  /** The org's conversations, newest activity first. Admin scope has no
   *  owner filter; a member reads only their own rows. */
  async list(filter: ConversationFilters): Promise<{ rows: ConversationRow[]; total: number }> {
    const params: unknown[] = [filter.orgId];
    const where: string[] = ["c.org_id = $1", "c.deleted_at IS NULL"];
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
      `SELECT c.id, c.title, ${utcText("c.created_at")} AS created_at,
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
       LEFT JOIN agent_threads pt ON pt.id = xt.parent_thread_id
       LEFT JOIN agents a ON a.id = xt.agent_id
       LEFT JOIN LATERAL (
         SELECT e.created_at FROM thread_events e WHERE e.chat_id = c.id ORDER BY e.seq DESC LIMIT 1
       ) le ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS messages FROM thread_events e
         WHERE e.chat_id = c.id AND e.type IN ('user_message','assistant_message')
       ) msg ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS runs,
                count(*) FILTER (WHERE r.status IN ('queued','running'))::int AS open_runs,
                count(*) FILTER (WHERE r.status = 'failed')::int AS failed_runs
         FROM agent_runs r WHERE r.thread_id = xt.id
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
  async header(orgId: string, chatId: string): Promise<ConversationRow | null> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT c.id, c.title, ${utcText("c.created_at")} AS created_at,
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
       LEFT JOIN agent_threads pt ON pt.id = xt.parent_thread_id
       LEFT JOIN agents a ON a.id = xt.agent_id
       LEFT JOIN LATERAL (
         SELECT e.created_at FROM thread_events e WHERE e.chat_id = c.id ORDER BY e.seq DESC LIMIT 1
       ) le ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS messages FROM thread_events e
         WHERE e.chat_id = c.id AND e.type IN ('user_message','assistant_message')
       ) msg ON true
       LEFT JOIN LATERAL (
         SELECT count(*)::int AS runs,
                count(*) FILTER (WHERE r.status IN ('queued','running'))::int AS open_runs,
                count(*) FILTER (WHERE r.status = 'failed')::int AS failed_runs
         FROM agent_runs r WHERE r.thread_id = xt.id
       ) runs ON true
       WHERE c.org_id = $1 AND c.id = $2`,
      [orgId, chatId],
    );
    const row = res.rows[0];
    return row === undefined ? null : rowToConversation(row);
  }

  /** One page of a conversation's message events, oldest first, plus the
   *  runs that overlap the page. */
  async detail(
    orgId: string,
    chatId: string,
    opts: { beforeSeq?: number; limit: number },
  ): Promise<{ messages: ConversationMessageRow[]; runs: ConversationRunRow[]; hasMore: boolean } | null> {
    const header = await this.header(orgId, chatId);
    if (header === null) return null;
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
    return { messages, runs: runsRes.rows.map(rowToRun), hasMore };
  }

  /** The thread a run belongs to, with its parent thread's chat. */
  async threadOfRun(orgId: string, threadId: string): Promise<ConversationThread | null> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT t.id, t.type, t.parent_thread_id, pt.chat_id AS parent_chat_id, pt.title AS parent_title
       FROM agent_threads t
       JOIN chats c ON c.id = t.chat_id
       LEFT JOIN agent_threads pt ON pt.id = t.parent_thread_id
       WHERE c.org_id = $1 AND t.id = $2`,
      [orgId, threadId],
    );
    const row = res.rows[0];
    if (row === undefined) return null;
    return {
      id: String(row["id"]),
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
