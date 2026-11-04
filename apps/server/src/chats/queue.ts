// The queue a chat's members see: the inputs waiting in the conversation's
// inbox, in placement order, as the ThreadState frame carries them. Writes
// (summaries, notices, posted agent messages) land at the next boundary
// without a turn and are not listed.

import type { InboxItem } from "@earendil-works/pi-durable";
import type { QueuedInput } from "@guild/wire/types";
import { queuedInbox } from "../storage/postgres/inbox.js";
import type { DurableQueryable } from "../storage/postgres/queries.js";
import { childResultOf } from "./child-result.js";
import { memberMessageOf } from "./member-message.js";
import { POSTED_TURN_KIND } from "./posted-turn.js";

/** The chat's queued inputs. */
export async function chatQueue(db: DurableQueryable, chatId: string): Promise<QueuedInput[]> {
  return (await queuedInbox(db, chatId)).flatMap(({ item, requestId }) => {
    const view = queuedInput(item, requestId);
    return view === null ? [] : [view];
  });
}

function queuedInput(item: InboxItem, requestId: string | null): QueuedInput | null {
  if (item.mode === "write") return null;
  const mode = item.mode === "steer" ? "steer" : "queue";
  const fallbackId = `submission:${Number(item.id)}`;
  const member = memberMessageOf(item.entry as never);
  if (member !== null) {
    return { id: member.message_id, kind: "message", mode, text: member.text, attachments: member.attachments };
  }
  const result = childResultOf(item.entry as never);
  if (result !== null) {
    const title = result.title === undefined || result.title === "" ? "" : ` "${result.title}"`;
    return {
      id: fallbackId,
      kind: "child_result",
      mode,
      text: `${result.agent_name ?? "Child"}${title}: ${result.status}`,
      attachments: result.attachments,
    };
  }
  const text = contentText(item.content);
  if (item.entry?.kind === POSTED_TURN_KIND) return { id: fallbackId, kind: "turn", mode, text, attachments: [] };
  // A plain user input (no Guild entry kind) is a member's message.
  return { id: requestId ?? fallbackId, kind: "message", mode, text, attachments: [] };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: { type?: string; text?: string }) =>
      part.type === "text" && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}
