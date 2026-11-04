// A member's message, placed as an input entry of its own kind. The entry
// carries what the thread shows (the message id, the text and the attached
// files), and the user row is projected from it when the inbox places the
// input, under the message id. Until then the message is only in the queue.

import type { EntryRecord } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord";
import type { MessageAttachment } from "../platform/domain/thread-events.js";

/** Entry kind of a member's message. */
export const MEMBER_MESSAGE_KIND = "guild.member-message";

export interface MemberMessage {
  /** The message id: the turn command id, and the id of its thread row. */
  message_id: string;
  text: string;
  attachments: MessageAttachment[];
}

/** The input entry a member's message is placed as. */
export function memberMessageEntry(message: MemberMessage): { kind: string; data: JsonValue } {
  return { kind: MEMBER_MESSAGE_KIND, data: JSON.parse(JSON.stringify(message)) as JsonValue };
}

/** The message an entry (or a queued item's entry) carries, or null. */
export function memberMessageOf(entry: Pick<EntryRecord, "kind" | "data"> | undefined): MemberMessage | null {
  if (entry?.kind !== MEMBER_MESSAGE_KIND) return null;
  const data = entry.data as Partial<MemberMessage> | null;
  if (data === null || typeof data !== "object" || typeof data.message_id !== "string") return null;
  return {
    message_id: data.message_id,
    text: typeof data.text === "string" ? data.text : "",
    attachments: Array.isArray(data.attachments) ? data.attachments : [],
  };
}
