// ThreadState capture + wire rendering: the authoritative atomic view the
// member socket syncs with and the SSE thread-stream endpoint
// pushes. Frame bytes match `serde_json::to_value(WsServerMsg::ThreadState)`
//: internally-tagged
// snake_case enum, fields in variant declaration order, `None` project
// fields skipped, `has_more_events` always present.

import type { ThreadEventRow } from "../platform/domain/thread-events.js";
import type { ChatsCtx } from "../platform/route-contexts.js";
import type { PlatformPool } from "../platform/db.js";
import { serializeServerMsg, type WsServerMsg } from "../hub/protocol.js";
import { ApiError } from "../platform/errors.js";
import type { UserRow } from "../platform/store/identity.js";

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
}

/** Events carried by one ThreadState frame: the newest window of the log.
 *  Older rows load on demand through GET /threads/:id/events. Every frame
 *  carries this window, and a live turn republishes it on each buffer
 *  change, so the window bounds the per-frame cost of a long thread. */
export const THREAD_STATE_EVENT_LIMIT = 120;

/** One atomic capture: history + the unpersisted model buffers + the chat
 *  status, with the watermark reserved AFTER the event read (seq is always
 *  newer than every row it carries). `caller` omitted = the notify-driven
 *  org-scoped republish path — no per-user gate; the payload is org-gated
 *  by construction). */
export async function captureThreadState(chats: ChatsCtx, pool: PlatformPool, orgId: string, chatId: string, caller?: UserRow): Promise<ThreadStateCapture> {
  if (caller !== undefined) await chats.chats.getChat(orgId, chatId, caller);
  const page = await chats.threads.listEventPage(orgId, chatId, { limit: THREAD_STATE_EVENT_LIMIT });
  const events = page.rows;
  const seq = await chats.threads.watermark();
  const buffers = chats.runtime.liveBuffers(chatId);
  // `compacting` reads the durable compaction tasks of the chat's
  // conversation: a compaction is in flight while its task is not terminal,
  // or while the summary write it finished with still waits in the inbox
  // for the running turn to end. Every other outcome (a summary, no
  // summary, a failure) reads false.
  const generatingRow = await pool.query<{ generating: boolean; compacting: boolean }>(
    "SELECT generating, EXISTS (" +
      "SELECT 1 FROM tasks t JOIN chat_conversations c ON c.conversation_id = t.conversation_id " +
      "LEFT JOIN submissions s ON t.status = 'terminal' AND s.conversation_id = t.conversation_id " +
      "AND s.status = 'queued' " +
      "AND s.id = (t.record::jsonb #>> '{state,outcome,result,submissionId}')::bigint " +
      "WHERE c.chat_id = chats.id AND t.kind = '\"pi.compaction\"' " +
      "AND (t.status <> 'terminal' OR s.id IS NOT NULL)" +
      ") AS compacting FROM chats WHERE id = $1 AND org_id = $2",
    [chatId, orgId],
  );
  if (generatingRow.rows.length === 0) throw new ApiError(404, "not_found", "chat not found");
  const project = await chats.chats.projectOf(orgId, chatId);
  return {
    chatId,
    seq,
    events,
    text: buffers.text,
    thinking: buffers.thinking,
    generating: generatingRow.rows[0]!.generating,
    projectId: project?.id,
    projectName: project?.name,
    projectMachineLabel: project?.label ?? undefined,
    hasMoreEvents: page.hasMore,
    compacting: generatingRow.rows[0]!.compacting,
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
  };
}
