// Thread event log store: the
// append-only `thread_events` table stays the client-render surface and the
// chat_reads read-marker space. The durable pi-durable conversation is the
// agent state; the bridge (chats/bridge.ts) appends the equivalent events
// here so GET /thread, the member WS, and unread derivation keep their
// exact contracts.

import { ApiError } from "../errors.js";
import { withTransaction, type PlatformPool, type PoolClient } from "../db.js";
import { jsonbText } from "../domain/text.js";
import { isUuid, pgTimestampToRfc3339, utcText, uuidv5, uuidv7 } from "../time.js";
import { normalizeThreadEvent, type ThreadEvent, type ThreadEventRow } from "../domain/thread-events.js";

export interface ChildResultRecord extends ThreadEventRow {
  event: Extract<ThreadEvent, { type: "child_result" }>;
}

export interface ProjectionCursor {
  entryId: number;
  turn: number;
  step: number;
  runOpen: boolean;
  legacyThrough?: number;
}

interface EventRowDb {
  id: string;
  chat_id: string;
  seq: number;
  type: string;
  payload: unknown;
  created_at: string;
}

function toRow(r: EventRowDb): ThreadEventRow | undefined {
  const event = normalizeThreadEvent(r.payload as Record<string, unknown>);
  // Lenient read for log listings: a payload written by a NEWER server
  // (unknown type) must not fail the whole chat history —
  // unparsable payloads are dropped.
  if (!event) return undefined;
  return { id: r.id, chat_id: r.chat_id, seq: Number(r.seq), event, created_at: pgTimestampToRfc3339(r.created_at) };
}

/** One message event as the history and search reads return it: `title`
 *  is the chat's title on a search hit and null on a history page. */
export interface MessageEventRow {
  chat_id: string;
  title: string | null;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

interface MessageEventDb extends Omit<MessageEventRow, "seq"> {
  seq: string;
}

const MESSAGE_TYPES = "('user_message','assistant_message','system_message')";

/** A message event whose content or a text block matches the ILIKE
 *  pattern bound at `param`. */
function messageTextMatch(param: string): string {
  return `(e.payload->>'content' ILIKE ${param} OR EXISTS (SELECT 1 FROM jsonb_array_elements(e.payload->'blocks') b WHERE b->>'type' = 'text' AND b->>'text' ILIKE ${param}))`;
}

/** Escapes the LIKE metacharacters of a user query used inside an ILIKE pattern. */
function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

function pageOf(rows: readonly MessageEventDb[], limit: number): { rows: MessageEventRow[]; more: boolean } {
  const more = rows.length > limit;
  return { rows: rows.slice(0, limit).map((row) => ({ ...row, seq: Number(row.seq) })), more };
}

/** Inserts one event row (an id conflict returns the existing row) and
 *  notifies `guild_thread_committed` inside the caller's transaction. */
async function insertEvent(
  client: PoolClient,
  chatId: string,
  eventId: string,
  event: ThreadEvent,
): Promise<ThreadEventRow> {
  const res = await client.query<EventRowDb>(
    `INSERT INTO thread_events (id, chat_id, type, payload) VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
     RETURNING id, chat_id, seq, payload, ${utcText("created_at")} AS created_at`,
    [eventId, chatId, event.type, jsonbText(event)],
  );
  const row = res.rows[0];
  if (!row) throw ApiError.internal("thread event append returned no row");
  await client.query("SELECT pg_notify('guild_thread_committed', $1)", [chatId]);
  const normalized = toRow(row);
  if (!normalized) throw ApiError.internal("appended thread event does not parse");
  return normalized;
}

/** The first decision journaled for one approval call, if any. */
async function recordedDecision(
  client: PoolClient,
  chatId: string,
  callId: string,
): Promise<ThreadEventRow | undefined> {
  const res = await client.query<EventRowDb>(
    `SELECT id, chat_id, seq, payload,
            ${utcText("created_at")} AS created_at
     FROM thread_events
     WHERE chat_id = $1 AND type = 'approval_decision' AND payload->>'call_id' = $2
     ORDER BY seq ASC LIMIT 1`,
    [chatId, callId],
  );
  const row = res.rows[0];
  return row === undefined ? undefined : toRow(row);
}

export class ThreadStore {
  constructor(private readonly pool: PlatformPool) {}

  /** Appends one event: uuid v7 id, `seq` from the BIGSERIAL (global write
   *  order). `id` supplied = idempotent re-append: the first version wins
   *  and a conflicting re-append returns the existing row unchanged. The
   *  approval gate re-runs recoverably and re-appends its card with a
   *  fresh judge timestamp in the payload — the re-append must keep the
   *  shown card, never fail the tool. An approval decision settles its call
   *  once: when the call already has one, that row is returned unchanged.
   *  Notifies `guild_thread_committed` in the same transaction (the
   *  member-socket sync channel). */
  appendEvent(chatId: string, event: ThreadEvent, id?: string): Promise<ThreadEventRow> {
    return this.persistEvent({ chatId, event, id });
  }

  /** Settles one approval call from the client's decision. Under the chat
   *  row lock the call's recorded decision, if any, is returned unchanged
   *  (`appended: false`); otherwise `decide` builds the decision from the
   *  chat's generating flag and it is appended. Concurrent resolves of one
   *  call therefore journal exactly one decision. */
  async settleApproval(
    chatId: string,
    callId: string,
    decide: (generating: boolean) => Extract<ThreadEvent, { type: "approval_decision" }>,
  ): Promise<{ row: ThreadEventRow; appended: boolean }> {
    return withTransaction(this.pool, async (client) => {
      const chat = await client.query<{ generating: boolean }>(
        "SELECT generating FROM chats WHERE id = $1 FOR UPDATE",
        [chatId],
      );
      if (chat.rows.length === 0) throw ApiError.notFound("no such chat");
      const recorded = await recordedDecision(client, chatId, callId);
      if (recorded !== undefined) return { row: recorded, appended: false };
      const row = await insertEvent(client, chatId, uuidv7(), decide(chat.rows[0]!.generating));
      return { row, appended: true };
    });
  }

  private async persistEvent(input: {
    chatId: string;
    event: ThreadEvent;
    id?: string;
    source?: { kind: "entry" | "task"; id: number; adoptLegacy: boolean };
  }): Promise<ThreadEventRow> {
    const { chatId, event, id } = input;
    const sourceId = input.source?.id;
    const adoptLegacy = input.source?.adoptLegacy ?? false;
    const table = input.source?.kind === "task" ? "chat_task_projections" : "chat_entry_projections";
    const column = input.source?.kind === "task" ? "task_id" : "entry_id";
    const payload = jsonbText(event);
    const eventType = event.type;
    const eventId = id ?? uuidv7();
    return withTransaction(this.pool, async (client) => {
      if (event.type === "approval_decision" && sourceId === undefined) {
        await client.query("SELECT id FROM chats WHERE id=$1 FOR UPDATE", [chatId]);
        const recorded = await recordedDecision(client, chatId, event.call_id);
        if (recorded !== undefined) return recorded;
      }
      if (sourceId !== undefined) {
        // The chat lock serializes adoption of pre-projection legacy rows.
        await client.query("SELECT id FROM chats WHERE id=$1 FOR UPDATE", [chatId]);
        const existing = await client.query<EventRowDb>(
          `SELECT e.id,e.chat_id,e.seq,e.payload,${utcText("e.created_at")} AS created_at FROM thread_events e
           JOIN ${table} p ON p.event_id=e.id WHERE p.${column}=$1 AND p.chat_id=$2`,
          [sourceId, chatId],
        );
        const legacy =
          existing.rows[0] || !adoptLegacy
            ? existing
            : await client.query<EventRowDb>(
                `SELECT e.id,e.chat_id,e.seq,e.payload,${utcText("e.created_at")} AS created_at FROM thread_events e
           WHERE e.chat_id=$1 AND e.type=$2 AND NOT EXISTS
             (SELECT 1 FROM ${table} p WHERE p.event_id=e.id)
             AND ((e.payload - 'turn' - 'step') = ($3::jsonb - 'turn' - 'step')
               OR ($2='tool_result' AND e.payload->>'call_id'=$3::jsonb->>'call_id'))
           ORDER BY e.seq LIMIT 1`,
                [chatId, eventType, payload],
              );
        const found = legacy.rows[0];
        if (found) {
          await client.query(
            `INSERT INTO ${table}(${column},chat_id,event_id) VALUES($1,$2,$3) ON CONFLICT(${column}) DO NOTHING`,
            [sourceId, chatId, found.id],
          );
          const normalized = toRow(found);
          if (!normalized) throw ApiError.internal("projected event does not parse");
          return normalized;
        }
      }
      const row = await insertEvent(client, chatId, eventId, event);
      if (sourceId !== undefined) {
        await client.query(`INSERT INTO ${table}(${column},chat_id,event_id) VALUES($1,$2,$3)`, [
          sourceId,
          chatId,
          eventId,
        ]);
      }
      return row;
    });
  }

  /** One delivery row in the parent thread. It stays unconsumed until a
   *  parent run takes the batch. */
  appendChildResult(chatId: string, event: Extract<ThreadEvent, { type: "child_result" }>): Promise<ThreadEventRow> {
    return this.appendEvent(chatId, event);
  }

  /** Unconsumed delivery rows in seq order. */
  async unconsumedChildResults(chatId: string): Promise<ChildResultRecord[]> {
    const res = await this.pool.query<EventRowDb>(
      `SELECT id, chat_id, seq, payload,
              ${utcText("created_at")} AS created_at
       FROM thread_events
       WHERE chat_id = $1 AND type = 'child_result' AND consumed_by_run_id IS NULL
       ORDER BY seq ASC`,
      [chatId],
    );
    return res.rows
      .map(toRow)
      .filter((row): row is ChildResultRecord => row !== undefined && row.event.type === "child_result");
  }

  /** Takes every unconsumed delivery row in one transaction and stamps it
   *  with the consuming run id. The lock makes concurrent drains safe: one
   *  batch belongs to exactly one run. */
  async consumeChildResults(chatId: string, runId: string): Promise<ChildResultRecord[]> {
    return withTransaction(this.pool, async (client) => {
      const res = await client.query<EventRowDb>(
        `SELECT id, chat_id, seq, payload,
                ${utcText("created_at")} AS created_at
         FROM thread_events
         WHERE chat_id = $1 AND type = 'child_result' AND consumed_by_run_id IS NULL
         ORDER BY seq ASC
         FOR UPDATE`,
        [chatId],
      );
      const rows = res.rows
        .map(toRow)
        .filter((row): row is ChildResultRecord => row !== undefined && row.event.type === "child_result");
      if (rows.length > 0) {
        await client.query("UPDATE thread_events SET consumed_by_run_id = $2 WHERE id = ANY($1::uuid[])", [
          rows.map((row) => row.id),
          runId,
        ]);
      }
      return rows;
    });
  }

  /** Returns a batch to the unconsumed pool when its steer could not be
   *  placed. The rows stay in the parent thread and the next drain takes
   *  them. */
  async releaseChildResults(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(
      `UPDATE thread_events SET consumed_by_run_id = NULL
       WHERE id = ANY($1::uuid[]) AND type = 'child_result'`,
      [ids],
    );
  }

  appendProjectedEntry(input: {
    chatId: string;
    entryId: number;
    event: ThreadEvent;
    adoptLegacy: boolean;
  }): Promise<ThreadEventRow> {
    const { chatId, entryId, event, adoptLegacy } = input;
    const id = uuidv5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", `guild-entry:${entryId}`);
    return this.persistEvent({ chatId, event, id, source: { kind: "entry", id: entryId, adoptLegacy } });
  }

  async appendTaskFailure(chatId: string, taskId: number, event: ThreadEvent): Promise<ThreadEventRow> {
    const boundary = await this.pool.query<{ legacy_task_id: number }>(
      "SELECT legacy_task_id FROM chat_recovery_metadata WHERE singleton=true",
    );
    return this.persistEvent({
      chatId,
      event,
      id: uuidv5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", `guild-task-failure:${taskId}`),
      source: { kind: "task", id: taskId, adoptLegacy: taskId <= Number(boundary.rows[0]?.legacy_task_id ?? 0) },
    });
  }

  async projectionCursor(chatId: string, conversationId: number): Promise<ProjectionCursor> {
    const res = await this.pool.query<{
      entry_id: number;
      turn: number;
      step: number;
      run_open: boolean;
      legacy_through_entry_id: number;
    }>(
      "SELECT entry_id,turn,step,run_open,legacy_through_entry_id FROM chat_projection_cursors WHERE chat_id=$1 AND conversation_id=$2",
      [chatId, conversationId],
    );
    const row = res.rows[0];
    return row
      ? {
          entryId: Number(row.entry_id),
          turn: row.turn,
          step: row.step,
          runOpen: row.run_open,
          legacyThrough: Number(row.legacy_through_entry_id),
        }
      : { entryId: 0, turn: 0, step: 0, runOpen: false };
  }

  async advanceProjection(chatId: string, conversationId: number, cursor: ProjectionCursor): Promise<void> {
    await this.pool.query(
      `INSERT INTO chat_projection_cursors(chat_id,conversation_id,entry_id,turn,step,run_open,legacy_through_entry_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(chat_id) DO UPDATE SET
      conversation_id=EXCLUDED.conversation_id,entry_id=EXCLUDED.entry_id,turn=EXCLUDED.turn,step=EXCLUDED.step,run_open=EXCLUDED.run_open,legacy_through_entry_id=EXCLUDED.legacy_through_entry_id
      WHERE chat_projection_cursors.conversation_id<>EXCLUDED.conversation_id OR chat_projection_cursors.entry_id<EXCLUDED.entry_id`,
      [chatId, conversationId, cursor.entryId, cursor.turn, cursor.step, cursor.runOpen, cursor.legacyThrough ?? 0],
    );
  }

  /** Delivery of one queued user_message echo (the Codex-style queued-send
   *  UX): the echo was written at accept time flagged `queued` — not yet
   *  seen by the model — and this moves it to a fresh seq with the flag
   *  removed when the durable inbox actually places the input. No-op when
   *  the row is missing or already delivered. Reserves a new watermark and
   *  notifies so live views reconcile (the fan-out lane re-delivers the
   *  moved row; the state lane re-captures the whole log). */
  async deliverQueuedEvent(chatId: string, id: string): Promise<ThreadEventRow | undefined> {
    // Submissions that are not user turns never have a queued echo, and
    // compaction runs use "compaction:<taskId>" request ids: a non-UUID id
    // must not reach the uuid-typed id column (the cast would throw).
    if (!isUuid(id)) return undefined;
    return withTransaction(this.pool, async (client) => {
      const res = await client.query<EventRowDb>(
        "SELECT id, chat_id, seq, type, payload, created_at FROM thread_events WHERE id = $1 AND chat_id = $2 FOR UPDATE",
        [id, chatId],
      );
      const row = res.rows[0];
      if (!row || (row.payload as Record<string, unknown> | null)?.queued !== true) {
        return undefined;
      }
      const payload = { ...(row.payload as Record<string, unknown>) };
      delete payload.queued;
      await client.query("DELETE FROM thread_events WHERE id = $1 AND chat_id = $2", [id, chatId]);
      // The move keeps the row's identity and content: type and created_at
      // ride along (type is NOT NULL — omitting it fails the insert), only
      // the seq (position) and the cleared flag change.
      const inserted = await client.query<EventRowDb>(
        // created_at rides through to_char like every other reader here —
        // a raw RETURNING hands the pg driver's Date to
        // pgTimestampToRfc3339, which expects the microsecond text shape.
        "INSERT INTO thread_events (id, chat_id, seq, type, payload, created_at) VALUES ($1, $2, nextval(pg_get_serial_sequence('thread_events', 'seq')), $3, $4::jsonb, $5) RETURNING id, chat_id, seq, type, payload, " +
          utcText("created_at") +
          " AS created_at",
        [id, chatId, row.type, jsonbText(payload), row.created_at],
      );
      await client.query("SELECT pg_notify('guild_thread_committed', $1)", [chatId]);
      const moved = inserted.rows[0]!;
      return toRow(moved);
    });
  }

  async setQueuedMode(chatId: string, id: string, mode: "steer" | "queue"): Promise<void> {
    await this.pool.query(
      `WITH updated AS (
      UPDATE thread_events SET payload=jsonb_set(payload,'{mode}',to_jsonb($3::text)),
        seq=nextval(pg_get_serial_sequence('thread_events','seq'))
      WHERE chat_id=$1 AND id=$2 AND payload->>'queued'='true' AND payload->>'mode' IS DISTINCT FROM $3
      RETURNING chat_id
    ) SELECT pg_notify('guild_thread_committed',chat_id::text) FROM updated`,
      [chatId, id, mode],
    );
  }

  /** Withdrawal of one queued echo (user trash / stop / archive): removes
   *  the never-delivered flagged row; a delivered or absent row is left
   *  alone. Reserves a watermark and notifies so live views reconcile. */
  async deleteQueuedEvent(chatId: string, id: string): Promise<void> {
    const res = await this.pool.query(
      "DELETE FROM thread_events WHERE id = $1 AND chat_id = $2 AND payload->>'queued' = 'true'",
      [id, chatId],
    );
    if (res.rowCount === 0) return;
    await this.watermark();
    await this.pool.query("SELECT pg_notify('guild_thread_committed', $1)", [chatId]);
  }

  /** The attachment ids of one run's turn: the user message nearest the
   *  run's start (written just before or just after the run row, so the
   *  nearest one in time is this turn's message even when later messages
   *  are already queued) plus the child results the run consumes. */
  async turnAttachmentIds(chatId: string, runId: string, startedAt: string): Promise<string[]> {
    const messages = await this.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM thread_events
       WHERE chat_id = $1 AND type = 'user_message'
       ORDER BY abs(extract(epoch FROM (created_at - $2::timestamptz))) ASC, seq DESC
       LIMIT 1`,
      [chatId, startedAt],
    );
    const deliveries = await this.pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM thread_events
       WHERE chat_id = $1 AND type = 'child_result'
         AND (consumed_by_run_id IS NULL OR consumed_by_run_id = $2)`,
      [chatId, runId],
    );
    const ids = new Set<string>();
    for (const row of [...messages.rows, ...deliveries.rows]) {
      const list = Array.isArray(row.payload.attachments) ? row.payload.attachments : [];
      for (const item of list) {
        if (typeof item === "string") ids.add(item);
        else if (item !== null && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
          ids.add((item as { id: string }).id);
        }
      }
    }
    return [...ids];
  }

  /** The type of the chat's newest durable event; undefined for an empty
   *  log. */
  async lastEventType(chatId: string): Promise<string | undefined> {
    const res = await this.pool.query<{ type: string }>(
      "SELECT type FROM thread_events WHERE chat_id = $1 ORDER BY seq DESC LIMIT 1",
      [chatId],
    );
    return res.rows[0]?.type;
  }

  /** Reserves a watermark in the same order space as the durable rows
   *  (ThreadState frame seq — "reserved from the thread-log sequence after
   *  capture"). */
  async watermark(): Promise<number> {
    const res = await this.pool.query<{ nextval: string }>(
      "SELECT nextval(pg_get_serial_sequence('thread_events', 'seq')) AS nextval",
    );
    return Number(res.rows[0]!.nextval);
  }

  /** Lists a chat's events, org-scoped via the chats join, ordered by seq. */
  async listEvents(orgId: string, chatId: string): Promise<ThreadEventRow[]> {
    const res = await this.pool.query<EventRowDb>(
      `SELECT e.id, e.chat_id, e.seq, e.payload,
              ${utcText("e.created_at")} AS created_at
       FROM thread_events e JOIN chats c ON c.id = e.chat_id
       WHERE c.org_id = $1 AND e.chat_id = $2 ORDER BY e.seq`,
      [orgId, chatId],
    );
    return res.rows.map(toRow).filter((row): row is ThreadEventRow => row !== undefined);
  }

  /** One page of a chat's events, newest-first window: rows with seq below
   *  `beforeSeq` (absent = the newest page), oldest-to-newest in the result.
   *  `hasMore` says an older page exists. The client renders a bounded tail
   *  and loads earlier pages on demand. */
  async listEventPage(
    orgId: string,
    chatId: string,
    opts: { beforeSeq?: number; limit: number },
  ): Promise<{ rows: ThreadEventRow[]; hasMore: boolean }> {
    const before = opts.beforeSeq ?? null;
    const res = await this.pool.query<EventRowDb>(
      `SELECT e.id, e.chat_id, e.seq, e.payload,
              ${utcText("e.created_at")} AS created_at
       FROM thread_events e JOIN chats c ON c.id = e.chat_id
       WHERE c.org_id = $1 AND e.chat_id = $2 AND ($3::bigint IS NULL OR e.seq < $3::bigint)
       ORDER BY e.seq DESC LIMIT $4`,
      [orgId, chatId, before, opts.limit + 1],
    );
    const hasMore = res.rows.length > opts.limit;
    const page = hasMore ? res.rows.slice(0, opts.limit) : res.rows;
    const rows = page
      .map(toRow)
      .filter((row): row is ThreadEventRow => row !== undefined)
      .reverse();
    return { rows, hasMore };
  }

  /** Events appended after `sinceSeq` (the incremental fan-out lane):
   *  chat-scoped, no org join — the feed calls this only for chats whose
   *  owner it already resolved. */
  async listEventsSince(chatId: string, sinceSeq: number): Promise<ThreadEventRow[]> {
    const res = await this.pool.query<EventRowDb>(
      `SELECT e.id, e.chat_id, e.seq, e.payload,
              ${utcText("e.created_at")} AS created_at
       FROM thread_events e
       WHERE e.chat_id = $1 AND e.seq > $2 ORDER BY e.seq`,
      [chatId, sinceSeq],
    );
    return res.rows.map(toRow).filter((row): row is ThreadEventRow => row !== undefined);
  }

  /** The latest decision journaled for one approval call, if any. */
  async latestApprovalDecision(
    chatId: string,
    callId: string,
  ): Promise<{ approved: boolean; reason: string | null } | null> {
    const res = await this.pool.query<{ approved: boolean; reason: string | null }>(
      `SELECT (payload->>'approved')::boolean AS approved, payload->>'reason' AS reason
       FROM thread_events WHERE chat_id = $1 AND type = 'approval_decision' AND payload->>'call_id' = $2
       ORDER BY seq DESC LIMIT 1`,
      [chatId, callId],
    );
    return res.rows[0] ?? null;
  }

  /** The judge verdict on the latest approval card for one call: undefined
   *  when the call has no card, null when its card carries no verdict. */
  async approvalRequestJudge(chatId: string, callId: string): Promise<Record<string, unknown> | null | undefined> {
    const res = await this.pool.query<{ judge: Record<string, unknown> | null }>(
      `SELECT payload->'judge' AS judge FROM thread_events
       WHERE chat_id = $1 AND type = 'approval_request' AND payload->>'call_id' = $2
       ORDER BY seq DESC LIMIT 1`,
      [chatId, callId],
    );
    const row = res.rows[0];
    return row === undefined ? undefined : row.judge;
  }

  /** One newest-first page of a chat's message events (user, assistant,
   *  system), optionally narrowed by role and a case-insensitive text match
   *  on message content; at most `limit` rows plus whether an older page
   *  exists. */
  async messagePage(
    chatId: string,
    opts: { role?: "user" | "assistant"; text?: string; beforeSeq?: number; limit: number },
  ): Promise<{ rows: MessageEventRow[]; more: boolean }> {
    const params: unknown[] = [chatId, opts.beforeSeq ?? null, opts.role === undefined ? null : `${opts.role}_message`];
    let textClause = "";
    if (opts.text !== undefined) {
      params.push(`%${likeEscape(opts.text)}%`);
      textClause = `AND ${messageTextMatch("$4")}`;
    }
    params.push(opts.limit + 1);
    const res = await this.pool.query<MessageEventDb>(
      `SELECT e.chat_id, NULL::text AS title, e.seq, e.type, e.payload, e.created_at
       FROM thread_events e
       WHERE e.chat_id = $1 AND e.type IN ${MESSAGE_TYPES}
         AND ($2::bigint IS NULL OR e.seq < $2::bigint)
         AND ($3::text IS NULL OR e.type = $3::text)
         ${textClause}
       ORDER BY e.seq DESC
       LIMIT $${params.length}`,
      params,
    );
    return pageOf(res.rows, opts.limit);
  }

  /** Message events containing `query` (case-insensitive) across every chat
   *  sharing `chatId`'s org and owner, newest first; at most `limit` rows
   *  plus whether more matched. */
  async searchOwnerMessages(
    chatId: string,
    query: string,
    limit: number,
  ): Promise<{ rows: MessageEventRow[]; more: boolean }> {
    const res = await this.pool.query<MessageEventDb>(
      `SELECT e.chat_id, c.title, e.seq, e.type, e.payload, e.created_at
       FROM thread_events e
       JOIN chats c ON c.id = e.chat_id
       WHERE c.org_id = (SELECT org_id FROM chats WHERE id = $1)
         AND c.user_id = (SELECT user_id FROM chats WHERE id = $1)
         AND e.type IN ${MESSAGE_TYPES}
         AND ${messageTextMatch("$2")}
       ORDER BY e.seq DESC
       LIMIT $3`,
      [chatId, `%${likeEscape(query)}%`, limit + 1],
    );
    return pageOf(res.rows, limit);
  }

  /** Highest `turn` value in the chat's log (0 when empty). */
  async latestTurn(chatId: string): Promise<number> {
    const res = await this.pool.query<{ max: number | null }>(
      "SELECT max((payload->>'turn')::int) AS max FROM thread_events WHERE chat_id = $1",
      [chatId],
    );
    return Math.max(0, res.rows[0]!.max ?? 0);
  }
}
