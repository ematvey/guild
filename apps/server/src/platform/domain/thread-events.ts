// Thread-event shapes and wire rendering (the Rust `ThreadEvent` enum,
// crates/protocol/src/api.rs, serde internally-tagged snake_case).
//
// Two concerns live here:
//  1. Typed constructors for the events this server writes (the bridge and
//     the turn-accept path), with fields in Rust declaration order.
//  2. `renderThreadEventRow` — the byte-compat wire form of a persisted row
//     ({id, chat_id, seq, event, created_at}, ThreadEventRow declaration
//     order) as the Rust server serializes it: compact JSON, variant fields
//     in declaration order, f64 fields keeping serde's ryu ".0" style
//     (rustJsonText). Clients render from these bytes; byte-compat is a
//     forced compat requirement (spec "Forced compat").
//
// Events written by the OLD Rust server carry the same shapes; the renderer
// normalizes both eras to one wire form.

import { rustFloat, rustJsonText } from "../provider/sse.js";
export { uuidv7 } from "../time.js";

// ---------------------------------------------------------------------------
// Event value types — generated protocol bindings (protocol::api), single
// source of truth with the Rust enum (serde internally-tagged snake_case).
// ---------------------------------------------------------------------------

import type { ThreadEvent } from "@guild/protocol/ThreadEvent.js";
import type { JudgeVerdict } from "@guild/protocol/JudgeVerdict.js";
export type { JudgeVerdict };
import type { Block } from "@guild/protocol/Block.js";
import type { MessageAttachment } from "@guild/protocol/MessageAttachment.js";
import type { UsagePayload } from "@guild/protocol/UsagePayload.js";
import type { ToolKind } from "@guild/protocol/ToolKind.js";

export type { Block, MessageAttachment, ThreadEvent, UsagePayload };

/** One persisted thread event as the store returns it. */
export interface ThreadEventRow {
  id: string;
  chat_id: string;
  seq: number;
  event: ThreadEvent;
  created_at: string; // RFC3339, serde-chrono style
}

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
// Wire rendering (byte-compat with the Rust serde_json output)
// ---------------------------------------------------------------------------

/** Serializes one ThreadEvent the way serde renders the Value-interpolated
 *  wire (serde_json Value maps are BTreeMap-sorted at EVERY level — the
 *  live :18080 capture confirms rows and event objects both come out in
 *  byte-sorted key order; skip_serializing_if honored, f64 values in ryu
 *  style). The input may be a parsed legacy row payload — unknown extra
 *  fields are dropped, exactly as a closed serde enum drops them
 *  (deny_unknown_fields is not set, but re-serialization never carries them
 *  either). */
export function threadEventWire(event: ThreadEvent): string {
  switch (event.type) {
    case "user_message":
      return obj({
        type: "user_message",
        content: event.content,
        attachments: event.attachments ?? [],
        ...(event.queued ? { queued: true } : {}),
        ...(event.mode ? { mode: event.mode } : {}),
      });
    case "system_message":
      return obj({ type: "system_message", content: event.content });
    case "assistant_message":
      return obj({
        type: "assistant_message",
        turn: event.turn,
        step: event.step,
        blocks: event.blocks,
        usage: raw(usageWire(event.usage)),
        model: event.model,
        interrupted: event.interrupted,
        error: event.error ?? undefined,
      });
    case "tool_result":
      return obj({
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
      });
    case "compaction":
      return obj({
        type: "compaction",
        summary: event.summary,
        tokens_before: event.tokens_before,
        keep_last: event.keep_last,
        model: event.model,
        usage: event.usage ? raw(usageWire(event.usage)) : undefined,
      });
    case "approval_request":
      return obj({ type: "approval_request", call_id: event.call_id, name: event.name, arguments: event.arguments });
    case "approval_decision":
      return obj({
        type: "approval_decision",
        call_id: event.call_id,
        approved: event.approved,
        reason: event.reason,
        expired: event.expired ?? false,
      });
    case "turn_error":
      return obj({ type: "turn_error", message: event.message });
    case "child_spawned":
      return obj({
        type: "child_spawned",
        thread_id: event.thread_id,
        run_id: event.run_id,
        chat_id: event.chat_id,
        agent_name: event.agent_name,
        title: event.title,
        status: event.status,
      });
    case "child_result":
      return obj({
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
      });
    case "child_closed":
      return obj({ type: "child_closed", thread_id: event.thread_id });
    default:
      throw new Error(`unknown thread event type ${(event as { type?: string }).type}`);
  }
}

/** One persisted row as serde_json renders the Value (sorted keys: the GET
 *  /thread list item and the ThreadState frame's event payloads). */
export function threadEventRowWire(row: ThreadEventRow): string {
  return obj({
    id: row.id,
    chat_id: row.chat_id,
    seq: row.seq,
    event: raw(threadEventWire(row.event)),
    created_at: row.created_at,
  });
}

/** UsagePayload wire form: all three fields are Option + skip_serializing_if
 *  (sorted: cost_usd, tokens_in, tokens_out). */
function usageWire(usage: UsagePayload | undefined): string {
  return obj({
    tokens_in: usage?.tokens_in,
    tokens_out: usage?.tokens_out,
    cost_usd: usage?.cost_usd === undefined ? undefined : rustFloat(usage.cost_usd),
  });
}

// Ordered-object helpers: insertion order kept, undefined dropped, and an
// already-rendered value (`raw()`) spliced in without re-quoting.

/** Embedded pre-rendered JSON (avoids double-quoting). */
function raw(text: string): { __raw: string } {
  return { __raw: text };
}

function isRaw(value: unknown): value is { __raw: string } {
  return typeof value === "object" && value !== null && "__raw" in (value as Record<string, unknown>);
}

function rustJsonTextRaw(value: unknown): string {
  if (isRaw(value)) return value.__raw;
  if (Array.isArray(value)) return `[${value.map(rustJsonTextRaw).join(",")}]`;
  if (value !== null && typeof value === "object" && !("__rustFloat" in value)) {
    // serde_json Value maps are BTreeMaps: byte-sorted keys at every level.
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${rustJsonTextRaw((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return rustJsonText(value);
}

function obj(fields: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    out[key] = value;
  }
  return rustJsonTextRaw(out);
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

/** Guild's turn derivation (restate.rs next_turn): max turn across
 *  assistant/tool-result events + 1. */
export function nextTurn(events: ThreadEventRow[]): number {
  return events.reduce((max, row) => {
    const ev = row.event;
    if (ev.type === "assistant_message" || ev.type === "tool_result") return Math.max(max, ev.turn);
    return max;
  }, 0) + 1;
}

/** Max step of one turn across the events (for steered continuations). */
export function maxStepOfTurn(events: ThreadEventRow[], turn: number): number {
  return events.reduce((max, row) => {
    const ev = row.event;
    if ((ev.type === "assistant_message" || ev.type === "tool_result") && ev.turn === turn) {
      return Math.max(max, ev.step);
    }
    return max;
  }, 0);
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