// Thread event shapes and the one thread read that does not ride the member
// socket: an older page of the durable log.

import { request } from "./api/request";
import type { ServerFrame, StreamEvent } from "@guild/wire/types";
import type {
  ThreadEvent,
  ThreadEventRow,
  UsagePayload,
  Block as ThreadBlock,
  MessageAttachment as MessageAttachmentMeta,
} from "@guild/wire/rest";

export type { StreamEvent, ThreadEvent, ThreadEventRow, UsagePayload, ThreadBlock, MessageAttachmentMeta };

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
  return request<ThreadEventsPage>("GET", `/api/v1/threads/${encodeURIComponent(chatId)}/events?${query}`, undefined, {
    signal,
  });
}
