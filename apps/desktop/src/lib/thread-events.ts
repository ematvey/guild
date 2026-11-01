// Thread event shapes and the one thread read that does not ride the member
// socket: an older page of the durable log.

import { apiUrl, getToken } from "./session";
import type { ServerFrame, StreamEvent } from "@guild/wire/types";
import type {
  ThreadEvent,
  ThreadEventRow,
  UsagePayload,
  Block as ThreadBlock,
  MessageAttachment as MessageAttachmentMeta,
} from "@guild/wire/rest";

export type {
  StreamEvent,
  ThreadEvent,
  ThreadEventRow,
  UsagePayload,
  ThreadBlock,
  MessageAttachmentMeta,
};

/** The `thread_state` frame body. */
export type ThreadState = Extract<ServerFrame, { type: "thread_state" }>;

export interface ThreadEventsPage {
  events: ThreadEventRow[];
  has_more: boolean;
}

/** One older page of a thread's durable log, for the scroll-to-top loader. */
export async function fetchThreadEventsPage(
  chatId: string,
  beforeSeq: number,
  limit: number,
  signal: AbortSignal,
): Promise<ThreadEventsPage> {
  const query = new URLSearchParams({ before: String(beforeSeq), limit: String(limit) });
  const response = await fetch(
    apiUrl(`/api/v1/threads/${encodeURIComponent(chatId)}/events?${query}`),
    { headers: { authorization: `Bearer ${getToken()}` }, signal },
  );
  if (!response.ok) throw new Error("Could not load earlier messages");
  return response.json();
}

// ---- Thread events (the event log is the durable source of truth; message
// history and the rendered thread are both derivations of it) ----

// The REST shapes live in @guild/wire/rest, hand-written from
// protocol/rest.schema.json. The local names stay for the view code.


/** Uploads one file as a chat context attachment (POST raw bytes, metadata
 * in the query string per the server contract). */

