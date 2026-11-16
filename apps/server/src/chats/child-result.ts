// A child result placed in its parent's conversation. Each result is one
// input, keyed by the child run id: the parent model reads the formatted
// text, a busy parent takes it at the next boundary (every queued steer at
// once, so results that finish together reach the model in one call), an
// idle one starts a run on it. The entry carries the child_result event,
// and the transcript card is projected from it, so a card shows exactly
// when the parent has the result. Until then it is only in the queue.

import type { EntryDraft, EntryRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { normalizeThreadEvent, type ThreadEvent } from "../platform/domain/thread-events.js";

export type ChildResultEvent = Extract<ThreadEvent, { type: "child_result" }>;

/** Entry kind of a placed child result. */
export const CHILD_RESULT_KIND = "guild.child-result";

/** The model-facing text of one child result. */
export function childResultText(event: ChildResultEvent, at: string): string {
  const reason = event.reason === null || event.reason === undefined ? "" : ` (${event.reason})`;
  const lines = [`Child result at ${at}:`, `thread ${event.thread_id} run ${event.run_id}: ${event.status}${reason}`];
  const text = event.final_text.trim();
  lines.push(text === "" ? "(no final text)" : text);
  if (event.attachments.length > 0) {
    lines.push(
      `Files (fetch with download): ${event.attachments.map((attachment) => `${attachment.filename} (${attachment.id})`).join(", ")}`,
    );
  }
  return lines.join("\n");
}

/** The input entry a child result is placed as. */
export function childResultEntry(event: ChildResultEvent): { kind: string; data: JsonValue } {
  return { kind: CHILD_RESULT_KIND, data: { result: JSON.parse(JSON.stringify(event)) as JsonValue } };
}

/** The child_result event an entry (or a queued item's entry) carries, or
 *  null for any other entry. */
export function childResultOf(entry: Pick<EntryRecord, "kind" | "data"> | undefined): ChildResultEvent | null {
  if (entry?.kind !== CHILD_RESULT_KIND) return null;
  const raw = (entry.data as { result?: unknown } | null)?.result;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const event = normalizeThreadEvent(raw as Record<string, unknown>);
  return event?.type === "child_result" ? event : null;
}

/** A child-result input withdrawn before placement (the parent was
 *  stopped), written as an entry instead: the parent has it in context and
 *  the card shows, but no run starts. */
export function childResultWrite(event: ChildResultEvent, content: unknown): EntryDraft {
  return {
    ...childResultEntry(event),
    model: [{ role: "user", content: content as string, timestamp: Date.now() }],
  };
}
