// A notice: something that happened outside a thread's own turns and that
// its agent must know (a member closed one of its child threads, another
// thread modified files this thread is working on). It is a conversation
// entry like any message: written at once when the thread is idle, else at
// the turn's next boundary. The agent reads its text as a user message, and
// the thread row is projected from the display event the entry carries.

import type { EntryDraft, EntryRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { normalizeThreadEvent, type ThreadEvent } from "../platform/domain/thread-events.js";

/** Entry kind of a notice. */
export const NOTICE_KIND = "guild.notice";

/** The entry of one notice: `text` is what the model reads, `event` the row
 *  the thread shows. */
export function noticeEntry(text: string, event: ThreadEvent): EntryDraft {
  return {
    kind: NOTICE_KIND,
    data: { event: JSON.parse(JSON.stringify(event)) as JsonValue },
    model: [{ role: "user", content: `[Notice] ${text}`, timestamp: Date.now() }],
  };
}

/** The display event a notice entry carries, or null for any other entry. */
export function noticeEventOf(entry: Pick<EntryRecord, "kind" | "data">): ThreadEvent | null {
  if (entry.kind !== NOTICE_KIND) return null;
  const data = entry.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  const raw = (data as { event?: unknown }).event;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  return normalizeThreadEvent(raw as Record<string, unknown>) ?? null;
}
