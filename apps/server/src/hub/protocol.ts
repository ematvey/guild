// Wire envelopes for the per-client WebSocket connection (the contract is
// protocol/socket.schema.json). Every message is a JSON text frame tagged by
// `type`.

import type { ClientFrame, Json, ServerFrame, StreamEvent } from "@guild/wire/types";
import { parseClientFrame } from "@guild/wire/parse";
import { threadEventRowObject, type ThreadEventRow } from "../platform/domain/thread-events.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server → client frame union. */
export type WsServerMsg = ServerFrame;

/** The StreamEvent variants the server streams inside live_frame frames. */
export type StreamWireEvent = StreamEvent;

/** Whether a frame waits for the end of an open sync bracket. A frame that
 *  describes live change (a generation delta, a status flip, a tree or
 *  usage push, an org event, an error) is held until `sync_done`, so the
 *  client applies it on top of the snapshot the bracket delivers; every
 *  other frame goes out in order. One entry per frame tag: a new frame
 *  fails the typecheck until it is classified here. */
export const DEFERRED_UNTIL_SYNC: { readonly [T in ServerFrame["type"]]: boolean } = {
  hello: false,
  displaced: false,
  auth_required: false,
  tool_dispatch: false,
  tool_cancel: false,
  error: true,
  machine_request: false,
  thread_list: false,
  chat_status: true,
  thread_events: false,
  sync_begin: false,
  thread_state: false,
  sync_done: false,
  pong: false,
  live_frame: true,
  org_event: true,
  subagent_tree: true,
  machine_status: false,
  archived_thread_list: false,
  project_list: false,
  machine_list: false,
  workspace_identity: false,
  model_list: false,
  member_profile: false,
  agent_list: false,
  integration_access: false,
  agent_run: false,
  agent_threads: false,
  agent_routines: false,
  skill_catalog: false,
  app_list: false,
  chat_tree: true,
  chat_row: false,
  context_usage: true,
};

/** Persisted rows that did not normalize to a known event type (they go
 *  out unchanged); the reporter, when set, hears each one. */
let malformedRows = 0;
let malformedReporter: ((error: unknown) => void) | null = null;

/** Routes each unnormalizable event row to `report` (the server log). */
export function reportMalformedEventRows(report: ((error: unknown) => void) | null): void {
  malformedReporter = report;
}

/** How many event rows this process sent unnormalized. */
export function malformedEventRowCount(): number {
  return malformedRows;
}

/** Normalizes persisted rows to their typed wire objects; a row that does
 *  not match a known event type passes through unchanged and is counted
 *  and reported. */
function eventRows(events: unknown[]): unknown[] {
  return events.map((row) => {
    try {
      return threadEventRowObject(row as ThreadEventRow);
    } catch (error) {
      malformedRows += 1;
      malformedReporter?.(error);
      return row;
    }
  });
}

export function serializeServerMsg(msg: WsServerMsg): string {
  if (msg.type === "thread_state" || msg.type === "thread_events") {
    return JSON.stringify({ ...msg, events: eventRows(msg.events) });
  }
  return JSON.stringify(msg);
}

/** Client → server. Parsing mirrors the contract's defaults: absent
 *  optional fields become null/empty; unknown variants (and unparseable
 *  text) return null and are discarded by the reader without closing the
 *  socket. */
export type WsClientMsg = ClientFrame;

/** A parsed client frame. `sync` always carries `chat_id` and `tool_result`
 *  always carries `meta` and `images` after normalization, so consumers see
 *  them as required. */
export type ParsedClientMsg =
  | Exclude<WsClientMsg, { type: "tool_result" | "sync" }>
  | (WsClientMsg & { type: "sync"; chat_id: string | null })
  | (WsClientMsg & { type: "tool_result"; images: string[]; meta: Json | null });

/** One client frame: the shared wire parser checks the JSON and the tag;
 *  the fields are checked here, since the text is untrusted. A frame with
 *  a malformed field is discarded whole. */
export function parseClientMsg(text: string): ParsedClientMsg | null {
  const frame = parseClientFrame(text);
  if (frame === null) return null;
  const raw = frame as unknown as Record<string, unknown>;
  switch (frame.type) {
    case "ping":
      return { type: "ping" };
    case "sync": {
      const chatId = raw["chat_id"];
      if (chatId === null || chatId === undefined) return { type: "sync", chat_id: null };
      return typeof chatId === "string" && UUID_RE.test(chatId) ? { type: "sync", chat_id: chatId } : null;
    }
    case "read": {
      const chatId = raw["chat_id"];
      return typeof chatId === "string" && UUID_RE.test(chatId) ? { type: "read", chat_id: chatId } : null;
    }
    case "machine_response": {
      const requestId = raw["request_id"];
      const ok = raw["ok"];
      if (typeof requestId !== "string" || typeof ok !== "boolean") return null;
      const out: WsClientMsg & { type: "machine_response" } = { type: "machine_response", request_id: requestId, ok };
      if (raw["payload"] !== undefined) out.payload = raw["payload"] as Json;
      if (typeof raw["error"] === "string") out.error = raw["error"];
      return out;
    }
    case "tool_result": {
      const chatId = raw["chat_id"];
      const callId = raw["call_id"];
      const content = raw["content"];
      const isError = raw["is_error"];
      if (
        typeof chatId !== "string" ||
        !UUID_RE.test(chatId) ||
        typeof callId !== "string" ||
        typeof content !== "string" ||
        typeof isError !== "boolean"
      ) {
        return null;
      }
      // images: optional; a present non-array (or a non-string element)
      // discards the frame.
      const images = raw["images"];
      if (images !== undefined && (!Array.isArray(images) || !images.every((i) => typeof i === "string"))) {
        return null;
      }
      return {
        type: "tool_result",
        chat_id: chatId,
        call_id: callId,
        content,
        is_error: isError,
        meta: (raw["meta"] as Json | undefined) ?? null,
        images: (images as string[] | undefined) ?? [],
      };
    }
    default: {
      const unhandled: never = frame;
      void unhandled;
      return null;
    }
  }
}
