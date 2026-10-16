// Thread event log store: the
// append-only `thread_events` table stays the client-render surface and the
// chat_reads read-marker space. The durable pi-durable conversation is the
// agent state; the bridge (chats/bridge.ts) appends the equivalent events
// here so GET /thread, the member WS (M5), and unread derivation keep their
// exact contracts.

import { ApiError } from "../errors.js";
import type { PlatformPool } from "../db.js";
import { pgTimestampToRfc3339, uuidv5, uuidv7 } from "../time.js";
import { normalizeThreadEvent, type ThreadEvent, type ThreadEventRow } from "../domain/thread-events.js";

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
  // Lenient read for log listings (Rust semantics): a payload written by a
  // NEWER server (unknown type) must not fail the whole chat history —
  // unparsable payloads are dropped.
  if (!event) return undefined;
  return { id: r.id, chat_id: r.chat_id, seq: Number(r.seq), event, created_at: pgTimestampToRfc3339(r.created_at) };
}

export class ThreadStore {
  constructor(private readonly pool: PlatformPool) {}

  /** Appends one event: uuid v7 id, `seq` from the BIGSERIAL (global write
   *  order). `id` supplied = idempotent re-append: the first version wins
   *  and a conflicting re-append returns the existing row unchanged. The
   *  approval gate re-runs recoverably and re-appends its card with a
   *  fresh judge timestamp in the payload — the re-append must keep the
   *  shown card, never fail the tool. Notifies `guild_thread_committed`
   *  in the same transaction (the member-socket sync channel; the M5
   *  lane's listener consumes it). */
  async appendEvent(chatId: string, event: ThreadEvent, id?: string, entryId?: number, adoptLegacy = false): Promise<ThreadEventRow> {
    // Postgres jsonb cannot hold U+0000 (tool output can: binary files,
    // /proc/*/environ); every NUL becomes U+FFFD.
    const payload = JSON.stringify(event, (_key, value: unknown) =>
      typeof value === "string" && value.includes("\u0000") ? value.replaceAll("\u0000", "\ufffd") : value,
    );
    const eventType = event.type;
    const eventId = id ?? uuidv7();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      if (entryId !== undefined) {
        // The chat lock serializes adoption of pre-projection legacy rows.
        await client.query("SELECT id FROM chats WHERE id=$1 FOR UPDATE", [chatId]);
        const existing = await client.query<EventRowDb>(
          `SELECT e.id,e.chat_id,e.seq,e.payload,to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM thread_events e
           JOIN chat_entry_projections p ON p.event_id=e.id WHERE p.entry_id=$1 AND p.chat_id=$2`,
          [entryId, chatId],
        );
        const legacy = existing.rows[0] || !adoptLegacy ? existing : await client.query<EventRowDb>(
          `SELECT e.id,e.chat_id,e.seq,e.payload,to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at FROM thread_events e
           WHERE e.chat_id=$1 AND e.type=$2 AND NOT EXISTS
             (SELECT 1 FROM chat_entry_projections p WHERE p.event_id=e.id)
             AND ((e.payload - 'turn' - 'step') = ($3::jsonb - 'turn' - 'step')
               OR ($2='tool_result' AND e.payload->>'call_id'=$3::jsonb->>'call_id'))
           ORDER BY e.seq LIMIT 1`, [chatId, eventType, payload],
        );
        const found = legacy.rows[0];
        if (found) {
          await client.query("INSERT INTO chat_entry_projections(entry_id,chat_id,event_id) VALUES($1,$2,$3) ON CONFLICT(entry_id) DO NOTHING", [entryId,chatId,found.id]);
          await client.query("COMMIT");
          const normalized = toRow(found);
          if (!normalized) throw new ApiError(500,"internal","projected event does not parse");
          return normalized;
        }
      }
      const res = await client.query<EventRowDb>(
        `INSERT INTO thread_events (id, chat_id, type, payload) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
         RETURNING id, chat_id, seq, payload, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`,
        [eventId, chatId, eventType, payload],
      );
      const row = res.rows[0];
      if (!row) throw new ApiError(500, "internal", "thread event append returned no row");
      if (entryId !== undefined) {
        await client.query("INSERT INTO chat_entry_projections(entry_id,chat_id,event_id) VALUES($1,$2,$3)", [entryId,chatId,eventId]);
      }
      await client.query("SELECT pg_notify('guild_thread_committed', $1)", [chatId]);
      await client.query("COMMIT");
      const normalized = toRow(row);
      if (!normalized) throw new ApiError(500, "internal", "appended thread event does not parse");
      return normalized;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async appendProjectedEntry(chatId: string, entryId: number, event: ThreadEvent, adoptLegacy = false): Promise<ThreadEventRow> {
    const id = uuidv5("6ba7b810-9dad-11d1-80b4-00c04fd430c8", `guild-entry:${entryId}`);
    return this.appendEvent(chatId, event, id, entryId, adoptLegacy);
  }

  async projectionCursor(chatId: string, conversationId: number): Promise<ProjectionCursor> {
    const res = await this.pool.query<{ entry_id: number; turn: number; step: number; run_open: boolean; legacy_through_entry_id: number }>(
      "SELECT entry_id,turn,step,run_open,legacy_through_entry_id FROM chat_projection_cursors WHERE chat_id=$1 AND conversation_id=$2", [chatId,conversationId],
    );
    const row = res.rows[0];
    return row ? { entryId: Number(row.entry_id), turn: row.turn, step: row.step, runOpen: row.run_open, legacyThrough: Number(row.legacy_through_entry_id) }
      : { entryId: 0, turn: 0, step: 0, runOpen: false };
  }

  async advanceProjection(chatId: string, conversationId: number, cursor: ProjectionCursor): Promise<void> {
    await this.pool.query(`INSERT INTO chat_projection_cursors(chat_id,conversation_id,entry_id,turn,step,run_open,legacy_through_entry_id)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(chat_id) DO UPDATE SET
      conversation_id=EXCLUDED.conversation_id,entry_id=EXCLUDED.entry_id,turn=EXCLUDED.turn,step=EXCLUDED.step,run_open=EXCLUDED.run_open,legacy_through_entry_id=EXCLUDED.legacy_through_entry_id
      WHERE chat_projection_cursors.conversation_id<>EXCLUDED.conversation_id OR chat_projection_cursors.entry_id<EXCLUDED.entry_id`,
      [chatId,conversationId,cursor.entryId,cursor.turn,cursor.step,cursor.runOpen,cursor.legacyThrough ?? 0]);
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
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return undefined;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query<EventRowDb>(
        "SELECT id, chat_id, seq, type, payload, created_at FROM thread_events WHERE id = $1 AND chat_id = $2 FOR UPDATE",
        [id, chatId],
      );
      const row = res.rows[0];
      if (!row || (row.payload as Record<string, unknown> | null)?.queued !== true) {
        await client.query("COMMIT");
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
        "INSERT INTO thread_events (id, chat_id, seq, type, payload, created_at) VALUES ($1, $2, nextval(pg_get_serial_sequence('thread_events', 'seq')), $3, $4::jsonb, $5) RETURNING id, chat_id, seq, type, payload, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at",
        [id, chatId, row.type, JSON.stringify(payload), row.created_at],
      );
      await client.query("SELECT pg_notify('guild_thread_committed', $1)", [chatId]);
      await client.query("COMMIT");
      const moved = inserted.rows[0]!;
      return toRow(moved);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
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
              to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM thread_events e JOIN chats c ON c.id = e.chat_id
       WHERE c.org_id = $1 AND e.chat_id = $2 ORDER BY e.seq`,
      [orgId, chatId],
    );
    return res.rows.map(toRow).filter((row): row is ThreadEventRow => row !== undefined);
  }

  /** Events appended after `sinceSeq` (the incremental fan-out lane):
   *  chat-scoped, no org join — the feed calls this only for chats whose
   *  owner it already resolved. */
  async listEventsSince(chatId: string, sinceSeq: number): Promise<ThreadEventRow[]> {
    const res = await this.pool.query<EventRowDb>(
      `SELECT e.id, e.chat_id, e.seq, e.payload,
              to_char(e.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM thread_events e
       WHERE e.chat_id = $1 AND e.seq > $2 ORDER BY e.seq`,
      [chatId, sinceSeq],
    );
    return res.rows.map(toRow).filter((row): row is ThreadEventRow => row !== undefined);
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