import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { InboxDoc, type Conversation, type UserInput } from "@earendil-works/pi-durable";

/** Appends text to the content of one pending, unplaced steer item. The
 *  boundary that later places the item appends the merged content as one user
 *  message. Returns false when the item is gone or no longer a steer. */
export async function appendToPendingSteer(
  conversation: Conversation,
  submissionId: number,
  text: string,
): Promise<boolean> {
  return conversation.commit(async (tx) => {
    const inbox = await tx.doc(InboxDoc, conversation.id);
    const item = inbox.items.find((candidate) => Number(candidate.id) === submissionId);
    if (item?.mode !== "steer") return false;
    item.content = appendText(item.content as UserInput, text) as typeof item.content;
    return true;
  }, BACKGROUND_CONTEXT);
}

/** Appends text to a user input, keeping the string shape or merging into the
 *  trailing text part of an array. */
function appendText(content: UserInput, text: string): UserInput {
  if (typeof content === "string") return content === "" ? text : `${content}\n\n${text}`;
  const parts = [...content];
  const last = parts[parts.length - 1];
  if (last !== undefined && last.type === "text") {
    parts[parts.length - 1] = { ...last, text: `${last.text}\n\n${text}` };
    return parts;
  }
  return [...parts, { type: "text", text }];
}
