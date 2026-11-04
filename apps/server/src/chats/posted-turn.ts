// A turn posted into a thread by the system rather than typed by a member: a
// subagent spawn or send, a routine run's prompt. It is placed as an input
// entry of its own kind, and the visible user message is projected from that
// entry, so the thread shows the prompt exactly when the agent has it. An
// input withdrawn before placement leaves no row behind.

import type { EntryRecord } from "@earendil-works/pi-durable";

/** Entry kind of a posted turn's input. */
export const POSTED_TURN_KIND = "guild.posted-turn";

/** The input entry a posted turn is placed as. */
export function postedTurnEntry(): { kind: string } {
  return { kind: POSTED_TURN_KIND };
}

/** The text of a posted turn's entry, or null for any other entry. */
export function postedTurnText(entry: Pick<EntryRecord, "kind" | "model">): string | null {
  if (entry.kind !== POSTED_TURN_KIND) return null;
  const message = entry.model?.find((item) => item.role === "user");
  if (message?.role !== "user") return null;
  const content = message.content;
  return typeof content === "string"
    ? content
    : content.map((part) => (part.type === "text" ? part.text : "")).join("");
}
