// Bounded thread transcript reads shared by conversation_read and the tree
// read tool: at most 200 events and 20k characters per call.

import type { PlatformPool } from "../platform/db.js";

export const MAX_READ_EVENTS = 200;
export const MAX_READ_CHARS = 20_000;
const MAX_EVENT_CHARS = 4_000;

export interface ThreadReadResult {
  thread_id: string;
  thread_title: string;
  events: { seq: number; type: string; ts: string; text: string }[];
  truncated: boolean;
}

function eventText(type: string, payload: Record<string, unknown>): string {
  if (type === "user_message" || type === "system_message" || type === "tool_result") {
    return typeof payload.content === "string" ? payload.content : "";
  }
  if (type === "assistant_message" && Array.isArray(payload.blocks)) {
    return (payload.blocks as { type?: string; text?: string }[])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text!)
      .join("\n");
  }
  return "";
}

function clip(text: string, max = MAX_EVENT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Reads one thread's events in seq order, oldest first, bounded by the
 *  shared event and character limits. */
export async function readThreadTranscript(
  pool: PlatformPool,
  args: {
    threadId: string;
    chatId: string;
    title: string;
    fromSeq?: number;
    toSeq?: number;
  },
): Promise<ThreadReadResult> {
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
  const res = await pool.query<{
    seq: string;
    type: string;
    payload: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT e.seq, e.type, e.payload, e.created_at
     FROM thread_events e
     WHERE ${where}
     ORDER BY e.seq ${ascending ? "ASC" : "DESC"}
     LIMIT ${MAX_READ_EVENTS + 1}`,
    params,
  );
  const truncated = res.rows.length > MAX_READ_EVENTS;
  let rows = truncated ? res.rows.slice(0, MAX_READ_EVENTS) : res.rows;
  if (!ascending) rows = [...rows].reverse();
  let used = 0;
  const events: ThreadReadResult["events"] = [];
  for (const row of rows) {
    const text = clip(eventText(row.type, row.payload));
    const room = MAX_READ_CHARS - used;
    if (room <= 0) break;
    const clipped = clip(text, Math.min(MAX_EVENT_CHARS, room));
    used += clipped.length;
    events.push({
      seq: Number(row.seq),
      type: row.type,
      ts: row.created_at.toISOString(),
      text: clipped,
    });
  }
  return { thread_id: args.threadId, thread_title: args.title, events, truncated };
}
