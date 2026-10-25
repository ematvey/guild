import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  GenerationTask,
  InboxDoc,
  LiveDoc,
  UserEntry,
  type Conversation,
  type EntryDraft,
} from "@earendil-works/pi-durable";

/** An idle final boundary, using the same one-at-a-time modes as Guild's
 * harness. It places existing submissions; it never fabricates a new input. */
export async function drainIdleInbox(conversation: Conversation): Promise<boolean> {
  return conversation.commit(async (tx) => {
    // Table reads precede the first write in a Session transaction.
    let head = (await tx.latestHeadMarker(conversation.id))?.head;
    const live = await tx.doc(LiveDoc, conversation.id);
    if (live.run !== undefined) return false;
    const inbox = await tx.doc(InboxDoc, conversation.id);
    if (inbox.items.length === 0) return false;
    const items = inbox.items;
    const writes = items.flatMap((item, index) => (item.mode === "write" ? [{ item, index }] : []));
    const steer = items.findIndex((item) => item.mode === "steer");
    const followUp = items.findIndex((item) => item.mode === "followUp");
    const users = [steer, followUp].filter((index) => index >= 0).sort((a, b) => a - b);
    for (const { item } of writes) {
      if (typeof item.entry.kind !== "string") throw new Error("queued entry has no kind");
      const draft = { ...item.entry, kind: item.entry.kind } as EntryDraft;
      if (typeof draft.head === "number" && head !== undefined && draft.head < head) {
        tx.settleSubmission(item.id, { status: "unanswered", reason: "stale" });
        continue;
      }
      const entry = await tx.appendEntry(conversation.id, draft);
      if (draft.head !== undefined) head = draft.head === "self" ? entry.id : draft.head;
      tx.placeSubmission(item.id, entry.id);
    }
    const inputs = [];
    for (const index of users) {
      const item = items[index]!;
      if (item.mode === "write") continue;
      const model = [{ role: "user" as const, content: item.content, timestamp: Date.now() }];
      const entry =
        item.entry === undefined
          ? await tx.appendEntry(UserEntry, conversation.id, { model })
          : await tx.appendEntry(conversation.id, {
              kind: item.entry.kind,
              ...(item.entry.data === undefined ? {} : { data: item.entry.data }),
              model,
            });
      tx.placeSubmission(item.id, entry.id);
      inputs.push(item.id);
    }
    for (const index of [...writes.map((write) => write.index), ...users].sort((a, b) => b - a)) items.splice(index, 1);
    if (inputs.length === 0) return false;
    live.run = {
      taskId: await tx.createTask(
        GenerationTask,
        {},
        { ownership: { kind: "conversation" }, conversationId: conversation.id },
      ),
      inputs,
    };
    return true;
  }, BACKGROUND_CONTEXT);
}
