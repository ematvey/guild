// Thread event shapes and the two thread reads that do not ride the member
// socket: an older page of the durable log and the context-usage meter.
// Shapes mirror crates/protocol/bindings/ThreadEvent.ts, tightened for the
// client (the wire carries JsonValue).

import { apiUrl, getToken } from "./session";
import type {
  ThreadEvent,
  UsagePayload,
  Block as ThreadBlock,
  MessageAttachment as MessageAttachmentMeta,
} from "@guild/wire/rest";

export type { ThreadEvent, UsagePayload, ThreadBlock, MessageAttachmentMeta };

export interface ThreadState {
  chat_id: string;
  seq: number;
  events: ThreadEventRow[];
  text: string;
  thinking: string;
  generating: boolean;
  /** An older page exists before `events[0]`. */
  has_more_events?: boolean;
  /** The chat's project, for the sidebar's grouping. */
  project_id?: string;
  project_name?: string;
  project_machine_label?: string;
};

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

export interface ThreadContextUsage {
  tokens: number | null;
  max: number | null;
  model: string | null;
  usage_model: string | null;
  /** Display name of `usage_model`; null when that route is gone or unnamed. */
  usage_model_alias: string | null;
}

export async function fetchThreadContext(chatId: string, model: string, signal: AbortSignal): Promise<ThreadContextUsage> {
  const query = new URLSearchParams({ model });
  const response = await fetch(apiUrl(`/api/v1/threads/${encodeURIComponent(chatId)}/context?${query}`), {
    headers: { authorization: `Bearer ${getToken()}` },
    signal,
  });
  if (!response.ok) throw new Error("Could not load context usage");
  return response.json();
}

// ---- Thread events (the event log is the durable source of truth; message
// history and the rendered thread are both derivations of it) ----

// The REST shapes live in @guild/wire/rest, hand-written from
// protocol/rest.schema.json. The local names stay for the view code.

export interface ThreadEventRow {
  id: string;
  seq: number;
  event: ThreadEvent;
  created_at: string;
}

export type StreamFrame = {
  type: string;
  content?: string;
  message?: string;
  tokens_in?: number;
  tokens_out?: number;
  // tool frames
  call_id?: string;
  name?: string;
  arguments?: string;
  executor?: string;
  is_error?: boolean;
  kind?: string;
  // approval frames
  approved?: boolean;
  reason?: string;
};

/** Uploads one file as a chat context attachment (POST raw bytes, metadata
 * in the query string per the server contract). */

