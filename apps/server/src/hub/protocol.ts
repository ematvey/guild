// Wire envelopes for the per-client WebSocket connection (crates/protocol/
// src/ws.rs). Every message is a JSON text frame tagged by `type`.

import type { ClientFrame, Json, ServerFrame, StreamEvent } from "@guild/wire/types";
import { threadEventRowObject, type ThreadEventRow } from "../platform/domain/thread-events.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server → client frame union. */
export type WsServerMsg = ServerFrame;

/** The StreamEvent variants the server streams inside live_frame frames
 *  (protocol::api::StreamEvent, serde internally-tagged snake_case). */
export type StreamWireEvent = StreamEvent;

/** Stream events ride the frame as their typed JSON shape. */
export function streamEventWire(event: StreamWireEvent): string {
  return JSON.stringify(event);
}

/** Normalizes persisted rows to their typed wire objects; a row that does
 *  not match a known event type passes through unchanged. */
function eventRows(events: unknown[]): unknown[] {
  return events.map((row) => {
    try {
      return threadEventRowObject(row as ThreadEventRow);
    } catch {
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

/** Client → server (crates/protocol/src/ws.rs WsClientMsg). Parsing mirrors
 *  serde's defaults: absent optional fields become null/empty; unknown
 *  variants (and unparseable text) return null and are discarded by the
 *  reader without closing the socket. */
export type WsClientMsg = ClientFrame;

/** A parsed client frame. `sync` always carries `chat_id` and `tool_result`
 *  always carries `meta` and `images` after normalization, so consumers see
 *  them as required. */
export type ParsedClientMsg =
  | Exclude<WsClientMsg, { type: "tool_result" | "sync" }>
  | (WsClientMsg & { type: "sync"; chat_id: string | null })
  | (WsClientMsg & { type: "tool_result"; images: string[]; meta: Json | null });

export function parseClientMsg(text: string): ParsedClientMsg | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== "object" || typeof raw["type"] !== "string") return null;
  switch (raw["type"]) {
    case "ping":
      return { type: "ping" };
    case "sync": {
      const chatId = raw["chat_id"];
      if (
        chatId !== null &&
        chatId !== undefined &&
        (typeof chatId !== "string" || !UUID_RE.test(chatId))
      ) {
        return null;
      }
      return { type: "sync", chat_id: chatId ?? null };
    }
    case "read": {
      const chatId = raw["chat_id"];
      if (typeof chatId !== "string" || !UUID_RE.test(chatId)) return null;
      return { type: "read", chat_id: chatId };
    }
    case "machine_response": {
      const requestId = raw["request_id"];
      if (typeof requestId !== "string") return null;
      const ok = raw["ok"];
      if (typeof ok !== "boolean") return null;
      const out: WsClientMsg & { type: "machine_response" } = {
        type: "machine_response",
        request_id: requestId,
        ok,
      };
      if (raw["payload"] !== undefined) out.payload = raw["payload"];
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
      // images: serde(default, skip_serializing_if empty Vec<String>) — a
      // present non-array (or non-string element) is a serde error, and the
      // frame is discarded whole.
      let images: string[] = [];
      if (raw["images"] !== undefined) {
        if (
          !Array.isArray(raw["images"]) ||
          !(raw["images"] as unknown[]).every((i) => typeof i === "string")
        ) {
          return null;
        }
        images = raw["images"] as string[];
      }
      return {
        type: "tool_result",
        chat_id: chatId,
        call_id: callId,
        content,
        is_error: isError,
        meta: raw["meta"] ?? null,
        images,
      };
    }
    default:
      return null;
  }
}
