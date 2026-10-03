// ThreadState capture + wire rendering: the authoritative atomic view the
// member socket (M5) syncs with and the M3 SSE thread-stream endpoint
// pushes. Frame bytes match `serde_json::to_value(WsServerMsg::ThreadState)`
// (crates/server/src/http/feed.rs `capture_thread`): internally-tagged
// snake_case enum, fields in variant declaration order, `None` project
// fields skipped, `has_more_events` always present.

import { threadEventRowWire, type ThreadEventRow } from "./thread-events.js";
import type { PlatformContext } from "../platform/context.js";
import { ApiError } from "../platform/http/error.js";
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
}

/** One atomic capture: history + the unpersisted model buffers + the chat
 *  status, with the watermark reserved AFTER the event read (seq is always
 *  newer than every row it carries). `caller` omitted = the notify-driven
 *  org-scoped republish path (Rust capture_thread's Option<&AuthUser>::None
 *  — no per-user gate; the payload is org-gated by construction). */
export async function captureThreadState(ctx: PlatformContext, orgId: string, chatId: string, caller?: UserRow): Promise<ThreadStateCapture> {
  if (caller !== undefined) await ctx.chats.getChat(orgId, chatId, caller);
  const events = await ctx.threads.listEvents(orgId, chatId);
  const seq = await ctx.threads.watermark();
  const buffers = ctx.runtime.liveBuffers(chatId);
  const generatingRow = await ctx.pool.query<{ generating: boolean }>(
    "SELECT generating FROM chats WHERE id = $1 AND org_id = $2",
    [chatId, orgId],
  );
  if (generatingRow.rows.length === 0) throw new ApiError(404, "not_found", "chat not found");
  const project = await ctx.chats.projectOf(orgId, chatId);
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
    hasMoreEvents: false,
  };
}

/** Byte-exact ThreadState frame (`{"type":"thread_state",…}`). */
export function threadStateWire(capture: ThreadStateCapture): string {
  const field = (name: string, value: string | undefined): string | undefined =>
    value === undefined ? undefined : `,"${name}":${value}`;
  const parts = [
    `{"type":"thread_state"`,
    `,"chat_id":${JSON.stringify(capture.chatId)}`,
    `,"seq":${capture.seq}`,
    `,"events":[${capture.events.map(threadEventRowWire).join(",")}]`,
    `,"text":${JSON.stringify(capture.text)}`,
    `,"thinking":${JSON.stringify(capture.thinking)}`,
    `,"generating":${capture.generating}`,
    field("project_id", capture.projectId === undefined ? undefined : JSON.stringify(capture.projectId)),
    field("project_name", capture.projectName === undefined ? undefined : JSON.stringify(capture.projectName)),
    field("project_machine_label", capture.projectMachineLabel === undefined ? undefined : JSON.stringify(capture.projectMachineLabel)),
    `,"has_more_events":${capture.hasMoreEvents}}`,
  ];
  return parts.filter((part) => part !== undefined).join("");
}
