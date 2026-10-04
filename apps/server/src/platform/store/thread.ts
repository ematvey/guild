// Thread event log store (crates/server/src/store/thread.rs port): the
// append-only `thread_events` table stays the client-render surface and the
// chat_reads read-marker space. The durable pi-durable conversation is the
// agent state; the bridge (chats/bridge.ts) appends the equivalent events
// here so GET /thread, the member WS (M5), and unread derivation keep their
// exact contracts.

import { ApiError } from "../errors.js";
import type { PlatformPool } from "../db.js";
import { pgTimestampToRfc3339, uuidv7 } from "../time.js";
import { normalizeThreadEvent, type ThreadEvent, type ThreadEventRow } from "../domain/thread-events.js";

interface EventRowDb {
  id: string;
  chat_id: string;
  seq: number;
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
   *  order). `id` supplied = idempotent re-append (retried durable writes),
   *  same ON CONFLICT semantics as the Rust append_event_with_id. Notifies
   *  `guild_thread_committed` in the same transaction (the member-socket
   *  sync channel; the M5 lane's listener consumes it). */
  async appendEvent(chatId: string, event: ThreadEvent, id?: string): Promise<ThreadEventRow> {
    const payload = JSON.stringify(event);
    const eventType = event.type;
    const eventId = id ?? uuidv7();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query<EventRowDb>(
        `INSERT INTO thread_events (id, chat_id, type, payload) VALUES ($1, $2, $3, $4::jsonb)
         ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
         WHERE thread_events.chat_id = EXCLUDED.chat_id AND thread_events.payload = EXCLUDED.payload
         RETURNING id, chat_id, seq, payload, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`,
        [eventId, chatId, eventType, payload],
      );
      const row = res.rows[0];
      if (!row) throw new ApiError(500, "internal", "thread event append returned no row");
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

  /** Highest `turn` value in the chat's log (0 when empty). */
  async latestTurn(chatId: string): Promise<number> {
    const res = await this.pool.query<{ max: number | null }>(
      "SELECT max((payload->>'turn')::int) AS max FROM thread_events WHERE chat_id = $1",
      [chatId],
    );
    return Math.max(0, res.rows[0]!.max ?? 0);
  }
}
