// ThreadState capture + wire rendering: the authoritative view the member
// socket syncs with and pushes. Frame bytes match the Rust
// `WsServerMsg::ThreadState` serialization: an internally-tagged snake_case
// enum, fields in variant declaration order, absent project fields skipped,
// `has_more_events` always present.

import type { ThreadEventRow } from "../platform/domain/thread-events.js";
import type { ChatStore } from "../platform/store/chats.js";
import type { ThreadStore } from "../platform/store/thread.js";
import type { LiveBuffers } from "./bridge.js";
import type { DurableQueryable } from "../storage/postgres/queries.js";
import { compactionInFlight } from "./compaction.js";
import { serializeServerMsg, type WsServerMsg } from "../hub/protocol.js";
import type { QueuedInput } from "@guild/wire/types";
import { ApiError } from "../platform/errors.js";
import type { UserRow } from "../platform/store/identity.js";

/** The reads one capture takes: the chat gate and project, the event page
 *  and watermark, and the turn's unpersisted buffers. */
export interface ThreadStateReads {
  readonly chats: Pick<ChatStore, "getChat" | "projectOf" | "generatingOf">;
  readonly threads: Pick<ThreadStore, "listEventPage" | "watermark">;
  readonly runtime: { liveBuffers(chatId: string): LiveBuffers; chatQueue(chatId: string): Promise<QueuedInput[]> };
}

export interface ThreadStateCapture {
  chatId: string;
  seq: number;
  events: ThreadEventRow[];
  text: string;
  thinking: string;
  generating: boolean;
  projectId: string | undefined;
  projectName: string | undefined;
  projectMachineLabel: string | undefined;
  hasMoreEvents: boolean;
  /** A compaction of the chat's context is running. Undefined only for
   *  captures rebuilt from frames that did not carry it. */
  compacting?: boolean;
  /** The inputs waiting in the chat's inbox. Undefined only for captures
   *  rebuilt from frames that did not carry it. */
  queue?: QueuedInput[];
}

/** Events carried by one ThreadState frame: the newest window of the log.
 *  Older rows load on demand through GET /threads/:id/events. Every frame
 *  carries this window, and a live turn republishes it on each buffer
 *  change, so the window bounds the per-frame cost of a long thread. */
export const THREAD_STATE_EVENT_LIMIT = 120;

/** Bytes one ThreadState frame may spend on its event window. A row count
 *  alone cannot bound the frame: one large row per event still multiplies
 *  into megabytes. Rows are dropped oldest-first until the window fits, and
 *  `has_more_events` then says the rest loads on demand. */
export const THREAD_STATE_BYTE_BUDGET = 512 * 1024;

/** Trims a newest-first window to the byte budget, always keeping the
 *  newest row: the tail is what the reader sees first. */
function fitWindow(rows: ThreadEventRow[], hasMore: boolean): { rows: ThreadEventRow[]; hasMore: boolean } {
  let total = 0;
  let start = rows.length;
  for (let i = rows.length - 1; i >= 0; i--) {
    const size = Buffer.byteLength(JSON.stringify(rows[i]), "utf8");
    // The newest row rides even when it alone exceeds the budget.
    if (start !== rows.length && total + size > THREAD_STATE_BYTE_BUDGET) break;
    total += size;
    start = i;
  }
  return { rows: rows.slice(start), hasMore: hasMore || start > 0 };
}

/** One atomic capture: history + the unpersisted model buffers + the chat
 *  status, with the watermark reserved AFTER the event read (seq is always
 *  newer than every row it carries). `pool` reads the durable compaction
 *  state. `caller` omitted = the org-scoped path (the notify-driven
 *  republish, and the socket's sync bracket, which gates first): no
 *  per-user gate; the payload is org-gated by construction. */
export async function captureThreadState(
  chats: ThreadStateReads,
  pool: DurableQueryable,
  orgId: string,
  chatId: string,
  caller?: UserRow,
): Promise<ThreadStateCapture> {
  if (caller !== undefined) await chats.chats.getChat(orgId, chatId, caller);
  // The queue is read before the events: an input placed between the two
  // reads then shows as its row, never as neither.
  const queue = await chats.runtime.chatQueue(chatId);
  const page = await chats.threads.listEventPage(orgId, chatId, { limit: THREAD_STATE_EVENT_LIMIT });
  const window = fitWindow(page.rows, page.hasMore);
  const seq = await chats.threads.watermark();
  const buffers = chats.runtime.liveBuffers(chatId);
  const generating = await chats.chats.generatingOf(orgId, chatId);
  if (generating === null) throw ApiError.notFound("chat not found");
  const project = await chats.chats.projectOf(orgId, chatId);
  const compacting = await compactionInFlight(pool, chatId);
  return {
    chatId,
    seq,
    events: window.rows,
    text: buffers.text,
    thinking: buffers.thinking,
    generating,
    projectId: project?.id,
    projectName: project?.name,
    projectMachineLabel: project?.label ?? undefined,
    hasMoreEvents: window.hasMore,
    compacting,
    queue,
  };
}

/** Byte-exact ThreadState frame (`{"type":"thread_state",…}`). */
export function threadStateWire(capture: ThreadStateCapture): string {
  return serializeServerMsg(threadStateMsg(capture));
}

/** The ThreadState frame as a WsServerMsg object — the member-socket sync
 *  bracket and the feed's view broadcasts (serializeServerMsg renders it
 *  byte-identically to threadStateWire). */
export function threadStateMsg(capture: ThreadStateCapture): WsServerMsg {
  return {
    type: "thread_state",
    chat_id: capture.chatId,
    seq: capture.seq,
    events: capture.events,
    text: capture.text,
    thinking: capture.thinking,
    generating: capture.generating,
    project_id: capture.projectId,
    project_name: capture.projectName,
    project_machine_label: capture.projectMachineLabel,
    has_more_events: capture.hasMoreEvents,
    compacting: capture.compacting,
    queue: capture.queue,
  };
}
