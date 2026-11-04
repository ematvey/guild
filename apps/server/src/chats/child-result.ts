// Child results placed in their parent's conversation. A batch is one input
// like a user message: the parent model reads the formatted text, a busy
// parent takes it at the next boundary, an idle one starts a run on it.
// Results that arrive while the batch is still queued merge into it, so
// however many children finish, the parent takes them in one placement. The
// entry carries the child_result events, and the transcript cards are
// projected from the entry, so a card shows exactly when the parent has the
// result. A batch never merges into an input of anyone else: withdrawing a
// user's queued message leaves it intact.

import type { EntryDraft, EntryRecord, InboxItem, UserInput } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import { normalizeThreadEvent } from "../platform/domain/thread-events.js";
import type { ChildResultEvent, ChildResultRecord } from "../platform/store/thread.js";

/** Entry kind of a placed child-result batch. */
export const CHILD_RESULT_KIND = "guild.child-result";

type ResultRow = Pick<ChildResultRecord, "created_at" | "event">;

/** The model-facing text of one child result. */
function resultText(row: ResultRow): string {
  const event = row.event;
  const reason = event.reason === null || event.reason === undefined ? "" : ` (${event.reason})`;
  const lines = [
    `Child result at ${row.created_at}:`,
    `thread ${event.thread_id} run ${event.run_id}: ${event.status}${reason}`,
  ];
  const text = event.final_text.trim();
  lines.push(text === "" ? "(no final text)" : text);
  if (event.attachments.length > 0) {
    lines.push(
      `Files: ${event.attachments.map((attachment) => `${attachment.filename} (${attachment.id})`).join(", ")}`,
    );
  }
  return lines.join("\n");
}

/** The model-facing text of a batch. */
export function childResultsText(rows: readonly ResultRow[]): string {
  return rows.map(resultText).join("\n\n");
}

/** The input entry a batch is placed as. */
export function childResultEntry(events: readonly ChildResultEvent[]): { kind: string; data: JsonValue } {
  return { kind: CHILD_RESULT_KIND, data: { results: JSON.parse(JSON.stringify(events)) as JsonValue } };
}

/** The child_result events an entry carries; empty for any other entry. */
export function childResultsOf(entry: Pick<EntryRecord, "kind" | "data">): ChildResultEvent[] {
  if (entry.kind !== CHILD_RESULT_KIND) return [];
  const data = entry.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) return [];
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) return [];
  return results.flatMap((raw) => {
    if (raw === null || typeof raw !== "object") return [];
    const event = normalizeThreadEvent(raw as Record<string, unknown>);
    return event?.type === "child_result" ? [event] : [];
  });
}

/** Appends a batch to the pending child-result steer in an inbox draft.
 *  Returns false when there is none: the caller submits a new input. */
export function mergeIntoPendingBatch(items: InboxItem[], rows: readonly ResultRow[]): boolean {
  const item = items.find((candidate) => candidate.mode === "steer" && candidate.entry?.kind === CHILD_RESULT_KIND);
  if (item === undefined || item.mode === "write" || item.entry === undefined) return false;
  const events = [...childResultsOf(copy(item.entry)), ...rows.map((row) => row.event)];
  const content = copy(item.content) as UserInput;
  const text = childResultsText(rows);
  item.content = (
    typeof content === "string" ? `${content}\n\n${text}` : [...content, { type: "text", text }]
  ) as typeof item.content;
  item.entry = childResultEntry(events) as typeof item.entry;
  return true;
}

/** A child-result batch still queued in the inbox. */
export interface QueuedChildResults {
  submissionId: number;
  content: UserInput;
  events: ChildResultEvent[];
}

/** The child-result batches among a conversation's queued inbox items. */
export function queuedChildResults(items: readonly InboxItem[]): QueuedChildResults[] {
  return items.flatMap((item) => {
    if (item.mode === "write" || item.entry?.kind !== CHILD_RESULT_KIND) return [];
    // Inbox items are draft overlays bound to the commit: copy them out.
    const events = childResultsOf(copy(item.entry));
    if (events.length === 0) return [];
    return [{ submissionId: Number(item.id), content: copy(item.content) as UserInput, events }];
  });
}

/** A batch withdrawn before placement (the parent was stopped), written as
 *  an entry instead: the parent has it in context and the cards show, but
 *  no run starts. */
export function childResultWrite(queued: QueuedChildResults): EntryDraft {
  return {
    ...childResultEntry(queued.events),
    model: [{ role: "user", content: queued.content, timestamp: Date.now() }],
  };
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
