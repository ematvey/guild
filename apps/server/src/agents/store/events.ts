// The agent lane's reads of a chat's journal (thread_events): bounded
// transcript slices, a run's turn events, its assistant messages, and the
// first user message a thread title is generated from.

import type { PlatformPool } from "../../platform/db.js";

export interface JournalEventRow {
  seq: string;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

/** Up to `limit` events of one chat within an optional seq range: ascending
 *  when a bound is given, else the newest first. */
export async function transcriptEvents(
  pool: PlatformPool,
  args: { chatId: string; fromSeq?: number; toSeq?: number; limit: number },
): Promise<JournalEventRow[]> {
  const params: unknown[] = [args.chatId];
  let where = "e.chat_id = $1";
  if (args.fromSeq !== undefined) {
    params.push(args.fromSeq);
    where += ` AND e.seq >= $${params.length}`;
  }
  if (args.toSeq !== undefined) {
    params.push(args.toSeq);
    where += ` AND e.seq <= $${params.length}`;
  }
  const ascending = args.fromSeq !== undefined || args.toSeq !== undefined;
  const res = await pool.query<JournalEventRow>(
    `SELECT e.seq, e.type, e.payload, e.created_at
     FROM thread_events e
     WHERE ${where}
     ORDER BY e.seq ${ascending ? "ASC" : "DESC"}
     LIMIT ${args.limit}`,
    params,
  );
  return res.rows;
}

/** A run's answer: the chat's latest assistant message with no tool call
 *  since `since`, or null when the run wrote none. */
export async function terminalAssistantSince(
  pool: PlatformPool,
  chatId: string,
  since: string,
): Promise<{ id: string; payload: Record<string, unknown> } | null> {
  const res = await pool.query<{ id: string; payload: Record<string, unknown> }>(
    `SELECT e.id, e.payload FROM thread_events e
     WHERE e.chat_id = $1 AND e.type = 'assistant_message' AND e.created_at >= $2::timestamptz
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(e.payload->'blocks', '[]'::jsonb)) b
         WHERE b->>'type' = 'tool_call')
     ORDER BY e.seq DESC LIMIT 1`,
    [chatId, since],
  );
  return res.rows[0] ?? null;
}

/** The tokens in and out of the chat's assistant messages since `since`. */
export async function assistantTokensSince(pool: PlatformPool, chatId: string, since: string): Promise<number> {
  const res = await pool.query<{ tokens: string | null }>(
    `SELECT SUM(COALESCE((e.payload->'usage'->>'tokens_in')::bigint, 0)
              + COALESCE((e.payload->'usage'->>'tokens_out')::bigint, 0))::text AS tokens
     FROM thread_events e
     WHERE e.chat_id = $1 AND e.type = 'assistant_message' AND e.created_at >= $2::timestamptz`,
    [chatId, since],
  );
  return Number(res.rows[0]?.tokens ?? 0);
}

/** The chat's events since `since`, oldest first, at most 400: one run's
 *  turn. */
export async function turnEventsSince(pool: PlatformPool, chatId: string, since: string): Promise<JournalEventRow[]> {
  const res = await pool.query<JournalEventRow>(
    `SELECT e.seq, e.type, e.payload, e.created_at
     FROM thread_events e
     WHERE e.chat_id = $1 AND e.created_at >= $2::timestamptz
     ORDER BY e.seq ASC
     LIMIT 400`,
    [chatId, since],
  );
  return res.rows;
}

/** The chat's assistant messages since `since`, newest first. */
export async function assistantEventsSince(
  pool: PlatformPool,
  chatId: string,
  since: string,
): Promise<{ type: string; payload: Record<string, unknown> }[]> {
  const res = await pool.query<{ type: string; payload: Record<string, unknown> }>(
    `SELECT type, payload FROM thread_events
     WHERE chat_id = $1 AND type = 'assistant_message'
       AND created_at >= $2::timestamptz
     ORDER BY seq DESC`,
    [chatId, since],
  );
  return res.rows;
}

/** The content of the chat's first user message, or null. */
export async function firstUserMessage(pool: PlatformPool, chatId: string): Promise<string | null> {
  const res = await pool.query<{ content: string | null }>(
    `SELECT payload->>'content' AS content FROM thread_events
     WHERE chat_id = $1 AND type = 'user_message' ORDER BY seq ASC LIMIT 1`,
    [chatId],
  );
  return res.rows[0]?.content ?? null;
}

/** Whether the chat already carries this system message text since `since`. */
export async function hasSystemMessageSince(
  pool: PlatformPool,
  chatId: string,
  text: string,
  since: string,
): Promise<boolean> {
  const res = await pool.query(
    `SELECT 1 FROM thread_events
     WHERE chat_id = $1 AND type = 'system_message'
       AND payload->>'content' = $2 AND created_at >= $3::timestamptz
     LIMIT 1`,
    [chatId, text, since],
  );
  return (res.rowCount ?? 0) > 0;
}
