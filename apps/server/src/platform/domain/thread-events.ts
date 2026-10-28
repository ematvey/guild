// Thread-event shapes and wire rendering (the Rust `ThreadEvent` enum,
// crates/protocol/src/api.rs, serde internally-tagged snake_case).
//
// Two concerns live here:
//  1. Typed constructors for the events this server writes (the bridge and
//     the turn-accept path).
//  2. The wire form of a persisted row ({id, chat_id, seq, event,
//     created_at}) as plain objects.
//
// The renderer turns a stored row into one wire form. A row that carries a
// field the current shape does not know is normalized to that shape.

export { uuidv7 } from "../time.js";

// ---------------------------------------------------------------------------
// Event value types — hand-written in @guild/wire/rest from
// protocol/rest.schema.json, single source of truth with the Rust enum
// (serde internally-tagged snake_case).
// ---------------------------------------------------------------------------

import type {
  ThreadEvent,
  ThreadEventRow,
  JudgeVerdict,
  Block,
  MessageAttachment,
  UsagePayload,
  ToolKind,
} from "@guild/wire/rest";

export type {
  Block,
  JudgeVerdict,
  MessageAttachment,
  ThreadEvent,
  ThreadEventRow,
  UsagePayload,
};

// ---------------------------------------------------------------------------
// Constructors (declaration order = future wire order)
// ---------------------------------------------------------------------------

export function userMessageEvent(content: string, attachments: MessageAttachment[] = []): ThreadEvent {
  return { type: "user_message", content, attachments };
}

export function systemMessageEvent(content: string): ThreadEvent {
  return { type: "system_message", content };
}

export function assistantMessageEvent(
  turn: number,
  step: number,
  blocks: Block[],
  usage: UsagePayload,
  model: string,
  interrupted?: boolean,
  error?: string,
): ThreadEvent {
  const ev: ThreadEvent = { type: "assistant_message", turn, step, blocks, usage, model };
  if (interrupted !== undefined) (ev as { interrupted?: boolean }).interrupted = interrupted;
  // A failed provider attempt tracks its error on the event itself; the
  // client renders it only while it is the thread's latest block (a later
  // retry that produced content supersedes it).
  if (error !== undefined) (ev as { error?: string }).error = error;
  return ev;
}

export function toolResultEvent(
  turn: number,
  step: number,
  callId: string,
  name: string,
  content: string,
  isError: boolean,
  meta?: unknown,
  images: string[] = [],
): ThreadEvent {
  const ev: ThreadEvent = {
    type: "tool_result",
    turn,
    step,
    call_id: callId,
    name,
    content,
    is_error: isError,
    images,
  };
  if (meta !== undefined && meta !== null) (ev as { meta?: unknown }).meta = meta;
  return ev;
}

export function compactionEvent(
  summary: string,
  extra?: { tokens_before?: number; keep_last?: number; model?: string; usage?: UsagePayload },
): ThreadEvent {
  const ev: ThreadEvent = { type: "compaction", summary };
  if (extra) {
    if (extra.tokens_before !== undefined) (ev as { tokens_before?: number }).tokens_before = extra.tokens_before;
    if (extra.keep_last !== undefined) (ev as { keep_last?: number }).keep_last = extra.keep_last;
    if (extra.model !== undefined) (ev as { model?: string }).model = extra.model;
    if (extra.usage !== undefined) (ev as { usage?: UsagePayload }).usage = extra.usage;
  }
  return ev;
}

export function approvalRequestEvent(
  callId: string,
  name: string,
  args: string,
  judge?: JudgeVerdict,
): ThreadEvent {
  const ev: ThreadEvent & { judge?: JudgeVerdict } = {
    type: "approval_request",
    call_id: callId,
    name,
    arguments: args,
  };
  if (judge !== undefined) ev.judge = judge;
  return ev;
}

export function approvalDecisionEvent(
  callId: string,
  approved: boolean,
  reason?: string,
  expired = false,
): ThreadEvent {
  const ev: ThreadEvent = { type: "approval_decision", call_id: callId, approved, expired };
  if (reason !== undefined) (ev as { reason?: string }).reason = reason;
  return ev;
}

export function turnErrorEvent(message: string): ThreadEvent {
  return { type: "turn_error", message };
}

// ---------------------------------------------------------------------------
// Wire rendering (plain objects, JSON text)
// ---------------------------------------------------------------------------

/** One ThreadEvent as a plain object. `undefined` fields stay absent in the
 *  JSON text; the shape is the closed typed variant, so extra input fields
 *  never reach the wire. */
export function threadEventObject(event: ThreadEvent): ThreadEvent {
  switch (event.type) {
    case "user_message":
      return {
        type: "user_message",
        content: event.content,
        attachments: event.attachments ?? [],
        ...(event.queued ? { queued: true } : {}),
        ...(event.mode ? { mode: event.mode } : {}),
      };
    case "system_message":
      return { type: "system_message", content: event.content };
    case "assistant_message":
      return {
        type: "assistant_message",
        turn: event.turn,
        step: event.step,
        blocks: event.blocks,
        usage: event.usage ?? {},
        model: event.model,
        interrupted: event.interrupted,
        error: event.error ?? undefined,
      };
    case "tool_result":
      return {
        type: "tool_result",
        turn: event.turn,
        step: event.step,
        call_id: event.call_id,
        name: event.name,
        content: event.content,
        is_error: event.is_error,
        meta: event.meta,
        images: event.images ?? [],
        kind: event.kind,
        artifact_id: event.artifact_id,
      };
    case "compaction":
      return {
        type: "compaction",
        summary: event.summary,
        tokens_before: event.tokens_before,
        keep_last: event.keep_last,
        model: event.model,
        usage: event.usage,
      };
    case "approval_request":
      return {
        type: "approval_request",
        call_id: event.call_id,
        name: event.name,
        arguments: event.arguments,
        ...(event.judge ? { judge: event.judge } : {}),
      };
    case "approval_decision":
      return {
        type: "approval_decision",
        call_id: event.call_id,
        approved: event.approved,
        reason: event.reason,
        expired: event.expired ?? false,
      };
    case "turn_error":
      return { type: "turn_error", message: event.message };
    case "child_spawned":
      return {
        type: "child_spawned",
        thread_id: event.thread_id,
        run_id: event.run_id,
        chat_id: event.chat_id,
        agent_name: event.agent_name,
        title: event.title,
        status: event.status,
        task: event.task,
      };
    case "child_result":
      return {
        type: "child_result",
        thread_id: event.thread_id,
        run_id: event.run_id,
        chat_id: event.chat_id,
        agent_name: event.agent_name,
        title: event.title,
        status: event.status,
        started_at: event.started_at,
        reason: event.reason,
        final_text: event.final_text,
        attachments: event.attachments ?? [],
      };
    case "child_closed":
      return { type: "child_closed", thread_id: event.thread_id };
    default:
      throw new Error(`unknown thread event type ${(event as { type?: string }).type}`);
  }
}

export function threadEventWire(event: ThreadEvent): string {
  return JSON.stringify(threadEventObject(event));
}

/** One persisted row as a plain object. */
export function threadEventRowObject(row: ThreadEventRow): ThreadEventRow {
  return {
    id: row.id,
    chat_id: row.chat_id,
    seq: row.seq,
    event: threadEventObject(row.event),
    created_at: row.created_at,
  };
}

export function threadEventRowWire(row: ThreadEventRow): string {
  return JSON.stringify(threadEventRowObject(row));
}

/** Normalizes a legacy parsed payload (from the DB JSONB column) into the
 *  typed shape so the renderer can emit declaration order. */
export function normalizeThreadEvent(payload: Record<string, unknown>): ThreadEvent | undefined {
  const type = payload["type"];
  switch (type) {
    case "user_message":
      return {
        type: "user_message",
        content: String(payload["content"] ?? ""),
        attachments: Array.isArray(payload["attachments"]) ? (payload["attachments"] as MessageAttachment[]) : [],
        ...(payload["queued"] === true ? { queued: true } : {}),
        ...(payload["mode"] === "steer" || payload["mode"] === "queue" ? { mode: payload["mode"] as "steer" | "queue" } : {}),
      };
    case "system_message":
      return { type: "system_message", content: String(payload["content"] ?? "") };
    case "assistant_message":
      return {
        type: "assistant_message",
        turn: Number(payload["turn"] ?? 0),
        step: Number(payload["step"] ?? 0),
        blocks: Array.isArray(payload["blocks"]) ? (payload["blocks"] as Block[]) : [],
        usage: (payload["usage"] ?? {}) as UsagePayload,
        model: String(payload["model"] ?? ""),
        ...(payload["interrupted"] === undefined ? {} : { interrupted: Boolean(payload["interrupted"]) }),
        ...(payload["error"] === undefined || payload["error"] === null ? {} : { error: String(payload["error"]) }),
      };
    case "tool_result":
      return {
        type: "tool_result",
        turn: Number(payload["turn"] ?? 0),
        step: Number(payload["step"] ?? 0),
        call_id: String(payload["call_id"] ?? ""),
        name: String(payload["name"] ?? ""),
        content: String(payload["content"] ?? ""),
        is_error: Boolean(payload["is_error"]),
        ...(payload["meta"] === undefined || payload["meta"] === null ? {} : { meta: payload["meta"] }),
        images: Array.isArray(payload["images"]) ? (payload["images"] as string[]) : [],
        ...(payload["kind"] === undefined ? {} : { kind: payload["kind"] as ToolKind }),
        ...(payload["artifact_id"] === undefined ? {} : { artifact_id: String(payload["artifact_id"]) }),
      };
    case "compaction":
      return {
        type: "compaction",
        summary: String(payload["summary"] ?? ""),
        ...(payload["tokens_before"] === undefined ? {} : { tokens_before: Number(payload["tokens_before"]) }),
        ...(payload["keep_last"] === undefined ? {} : { keep_last: Number(payload["keep_last"]) }),
        ...(payload["model"] === undefined ? {} : { model: String(payload["model"]) }),
        ...(payload["usage"] === undefined ? {} : { usage: payload["usage"] as UsagePayload }),
      };
    case "approval_request":
      return {
        type: "approval_request",
        call_id: String(payload["call_id"] ?? ""),
        name: String(payload["name"] ?? ""),
        arguments: String(payload["arguments"] ?? ""),
        ...(payload["judge"] === undefined || payload["judge"] === null
          ? {}
          : { judge: payload["judge"] as JudgeVerdict }),
      };
    case "approval_decision":
      return {
        type: "approval_decision",
        call_id: String(payload["call_id"] ?? ""),
        approved: Boolean(payload["approved"]),
        ...(payload["reason"] === undefined ? {} : { reason: String(payload["reason"]) }),
        expired: Boolean(payload["expired"] ?? false),
      };
    case "turn_error":
      return { type: "turn_error", message: String(payload["message"] ?? "") };
    case "child_spawned":
      return {
        type: "child_spawned",
        thread_id: String(payload["thread_id"] ?? ""),
        run_id: String(payload["run_id"] ?? ""),
        chat_id: String(payload["chat_id"] ?? ""),
        agent_name: String(payload["agent_name"] ?? ""),
        title: String(payload["title"] ?? ""),
        status: String(payload["status"] ?? ""),
        task: String(payload["task"] ?? ""),
      };
    case "child_result":
      return {
        type: "child_result",
        thread_id: String(payload["thread_id"] ?? ""),
        run_id: String(payload["run_id"] ?? ""),
        chat_id: String(payload["chat_id"] ?? ""),
        agent_name: String(payload["agent_name"] ?? ""),
        title: String(payload["title"] ?? ""),
        status: String(payload["status"] ?? ""),
        ...(payload["started_at"] === undefined || payload["started_at"] === null
          ? {}
          : { started_at: String(payload["started_at"]) }),
        ...(payload["reason"] === undefined || payload["reason"] === null ? {} : { reason: String(payload["reason"]) }),
        final_text: String(payload["final_text"] ?? ""),
        attachments: Array.isArray(payload["attachments"]) ? (payload["attachments"] as MessageAttachment[]) : [],
      };
    case "child_closed":
      return { type: "child_closed", thread_id: String(payload["thread_id"] ?? "") };
    default:
      return undefined;
  }
}



/** Renders the model-facing summary text of a pi-durable CompactionEntry as
 *  the Guild Compaction event's `summary` (strips pi-durable's wrapper when
 *  present; importer-era rows already carry the Rust-style summary). */
export function unwrapCompactionSummary(text: string): string {
  const prefix = "The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
  const suffix = "\n</summary>";
  if (text.startsWith(prefix) && text.endsWith(suffix)) {
    return text.slice(prefix.length, text.length - suffix.length);
  }
  return text;
}
