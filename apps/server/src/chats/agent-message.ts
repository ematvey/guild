// An agent message posted into a chat outside a turn (send_message: a
// routine's feed, a thread an agent opens). It is a conversation entry like
// any reply: the model reads it as its own assistant message, compaction
// summarizes it, and the transcript row is projected from it.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { EntryDraft, EntryRecord } from "@earendil-works/pi-durable";
import { guildProviderId } from "../harness/models.js";

/** Entry kind of a posted agent message. Not `pi.assistant`: no generation
 *  produced it, so run bookkeeping and per-request usage do not apply. */
export const AGENT_MESSAGE_KIND = "guild.agent-message";

/** The write-submission entry for one posted message. Usage is zero: no
 *  request measured it, so context estimates count its text instead. */
export function agentMessageEntry(orgId: string, model: string | null, text: string): EntryDraft {
  const message: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: guildProviderId(orgId),
    model: model ?? "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  return { kind: AGENT_MESSAGE_KIND, model: [message] };
}

/** The posted message an entry carries, or null for any other entry. */
export function agentMessageOf(entry: EntryRecord): AssistantMessage | null {
  if (entry.kind !== AGENT_MESSAGE_KIND) return null;
  const message = entry.model?.find((item) => item.role === "assistant");
  return message?.role === "assistant" ? message : null;
}
