// Wire envelopes for the per-client WebSocket connection (crates/protocol/
// src/ws.rs). Every message is a JSON text frame tagged by `type`.
//
// Frames must be BYTE-compatible with the Rust server (shipped daemons never
// update): serde_json serializes an internally-tagged enum as the `type` tag
// first, then the variant's fields in declaration order, snake_case field
// names as declared, Option::None fields omitted (skip_serializing_if). We
// build plain objects with keys inserted in exactly that order —
// JSON.stringify preserves string-key insertion order.

import { threadEventRowWire } from "../platform/domain/thread-events.js";
import { rustFloatText } from "../platform/provider/rust-json.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server → client. Returns the exact bytes serde_json::to_string would
 *  produce for each WsServerMsg variant. */
export type WsServerMsg =
  | { type: "tool_cancel"; call_id: string }
  | { type: "hello" }
  | { type: "displaced" }
  | { type: "auth_required" }
  | {
      type: "tool_dispatch";
      chat_id: string;
      call_id: string;
      name: string;
      arguments: string;
      workdir?: string;
    }
  | { type: "error"; message: string }
  | { type: "machine_request"; request_id: string; op: string; payload: unknown }
  | { type: "thread_list"; chats: unknown[] }
  | { type: "chat_status"; chat_id: string; generating: boolean }
  | { type: "sync_begin"; chat_id: string }
  | {
      type: "thread_state";
      chat_id: string;
      seq: number;
      events: unknown[];
      text: string;
      thinking: string;
      generating: boolean;
      project_id?: string;
      project_name?: string;
      project_machine_label?: string;
      has_more_events?: boolean;
    }
  | { type: "sync_done"; chat_id: string }
  | {
      type: "thread_events";
      chat_id: string;
      seq: number;
      events: unknown[];
    }
  | { type: "pong" }
  | {
      type: "live_frame";
      chat_id: string;
      generation_id: string;
      seq: number;
      machine_id: string | null;
      event: StreamWireEvent | unknown;
    }
  | { type: "org_event"; event: unknown }
  | {
      type: "subagent_tree";
      chat_id: string;
      nodes: unknown[];
    }
  | { type: "machine_status"; machine_id: string; online: boolean }
  | { type: "archived_thread_list"; chats: unknown[] }
  | {
      type: "project_list";
      projects: unknown[];
      archived_projects: unknown[];
    }
  | { type: "machine_list"; machines: unknown[] }
  | { type: "workspace_identity"; name: string; logo_url?: string };

/** The StreamEvent variants the server streams inside live_frame frames
 *  (protocol::api::StreamEvent, serde internally-tagged snake_case). */
export type StreamWireEvent =
  | { type: "delta"; content: string }
  | { type: "thinking_delta"; content: string }
  | { type: "tool_started"; call_id: string; name: string; arguments: string; executor: "client" | "server"; kind?: string }
  | { type: "tool_completed"; call_id: string; name: string; content: string; is_error: boolean }
  | { type: "done"; message_id: string; cost_usd: number; tokens_in: number; tokens_out: number }
  | { type: "error"; code: string; message: string };

function rawJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "null";
  }
}

/** Marks an already-encoded JSON fragment so wireObject splices it in
 *  verbatim (nested enum values and pre-rendered rows). */
function raw(json: string): { __raw: string } {
  return { __raw: json };
}

/** Renders one wire field value: pre-rendered fragments verbatim, floats
 *  through serde's ryu rules, everything else plain. */
function wireValue(value: unknown): string {
  if (value !== null && typeof value === "object") {
    if ("__raw" in value) return (value as { __raw: string }).__raw;
    if ("__rustFloat" in value) return rustFloatText((value as { __rustFloat: number }).__rustFloat);
    return rawJson(value);
  }
  return JSON.stringify(value);
}

function wireObject(fields: [string, unknown][]): string {
  const parts: string[] = [];
  for (const [key, value] of fields) {
    if (value === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${wireValue(value)}`);
  }
  return `{${parts.join(",")}}`;
}

/** Byte-exact StreamEvent rendering: `cost_usd` keeps serde's ryu `.0`
 *  style (rustFloat), fields ride variant declaration order. Unknown
 *  variants fall back to plain stringify (the bridge never emits them). */
export function streamEventWire(event: StreamWireEvent | unknown): string {
  switch ((event as StreamWireEvent).type) {
    case "delta":
      return wireObject([
        ["type", "delta"],
        ["content", (event as { content: string }).content],
      ]);
    case "thinking_delta":
      return wireObject([
        ["type", "thinking_delta"],
        ["content", (event as { content: string }).content],
      ]);
    case "tool_started": {
      const started = event as { call_id: string; name: string; arguments: string; executor: string; kind?: string };
      return wireObject([
        ["type", "tool_started"],
        ["call_id", started.call_id],
        ["name", started.name],
        ["arguments", started.arguments],
        ["executor", started.executor],
        ["kind", started.kind],
      ]);
    }
    case "tool_completed": {
      const completed = event as { call_id: string; name: string; content: string; is_error: boolean };
      return wireObject([
        ["type", "tool_completed"],
        ["call_id", completed.call_id],
        ["name", completed.name],
        ["content", completed.content],
        ["is_error", completed.is_error],
      ]);
    }
    case "done": {
      const done = event as { message_id: string; cost_usd: number; tokens_in: number; tokens_out: number };
      return wireObject([
        ["type", "done"],
        ["message_id", done.message_id],
        ["cost_usd", raw(rustFloatText(done.cost_usd))],
        ["tokens_in", done.tokens_in],
        ["tokens_out", done.tokens_out],
      ]);
    }
    case "error": {
      const error = event as { code: string; message: string };
      return wireObject([
        ["type", "error"],
        ["code", error.code],
        ["message", error.message],
      ]);
    }
    default:
      return rawJson(event);
  }
}

/** Builds a frame object with serde's key order. Fields are applied in the
 *  exact declaration order of each Rust variant; `undefined` values are
 *  skipped like Option::None with skip_serializing_if. */
function frame(type: string, fields: [string, unknown][]): Record<string, unknown> {
  const out: Record<string, unknown> = { type };
  for (const [key, value] of fields) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

export function serializeServerMsg(msg: WsServerMsg): string {
  switch (msg.type) {
    case "hello":
      return JSON.stringify(frame("hello", []));
    case "displaced":
      return JSON.stringify(frame("displaced", []));
    case "auth_required":
      return JSON.stringify(frame("auth_required", []));
    case "pong":
      return JSON.stringify(frame("pong", []));
    case "tool_cancel":
      return JSON.stringify(frame("tool_cancel", [["call_id", msg.call_id]]));
    case "tool_dispatch":
      return JSON.stringify(
        frame("tool_dispatch", [
          ["chat_id", msg.chat_id],
          ["call_id", msg.call_id],
          ["name", msg.name],
          ["arguments", msg.arguments],
          ["workdir", msg.workdir],
        ]),
      );
    case "error":
      return JSON.stringify(frame("error", [["message", msg.message]]));
    case "machine_request":
      return JSON.stringify(
        frame("machine_request", [
          ["request_id", msg.request_id],
          ["op", msg.op],
          ["payload", msg.payload],
        ]),
      );
    case "thread_list":
      return JSON.stringify(frame("thread_list", [["chats", msg.chats]]));
    case "chat_status":
      return JSON.stringify(
        frame("chat_status", [
          ["chat_id", msg.chat_id],
          ["generating", msg.generating],
        ]),
      );
    case "sync_begin":
      return JSON.stringify(frame("sync_begin", [["chat_id", msg.chat_id]]));
    case "thread_events": {
      // Same row renderer as thread_state — event rows must stay byte-exact
      // with the replayed log (sorted keys, ryu floats).
      const rows = (msg.events as unknown[])
        .map((row) => {
          try {
            return threadEventRowWire(row as Parameters<typeof threadEventRowWire>[0]);
          } catch {
            return JSON.stringify(row);
          }
        })
        .join(",");
      return wireObject([
        ["type", "thread_events"],
        ["chat_id", msg.chat_id],
        ["seq", msg.seq],
        ["events", raw(`[${rows}]`)],
      ]);
    }
    case "thread_state": {
      // The event rows render through the byte-exact row renderer (serde
      // Value rows: sorted keys, ryu floats) — a plain stringify would lose
      // both (the M3 live-capture finding).
      const rows = (msg.events as unknown[])
        .map((row) => {
          try {
            return threadEventRowWire(row as Parameters<typeof threadEventRowWire>[0]);
          } catch {
            return JSON.stringify(row);
          }
        })
        .join(",");
      return wireObject([
        ["type", "thread_state"],
        ["chat_id", msg.chat_id],
        ["seq", msg.seq],
        ["events", raw(`[${rows}]`)],
        ["text", msg.text],
        ["thinking", msg.thinking],
        ["generating", msg.generating],
        ["project_id", msg.project_id],
        ["project_name", msg.project_name],
        ["project_machine_label", msg.project_machine_label],
        ["has_more_events", msg.has_more_events],
      ]);
    }
    case "sync_done":
      return JSON.stringify(frame("sync_done", [["chat_id", msg.chat_id]]));
    case "live_frame":
      return wireObject([
        ["type", "live_frame"],
        ["chat_id", msg.chat_id],
        ["generation_id", msg.generation_id],
        ["seq", msg.seq],
        ["machine_id", msg.machine_id],
        ["event", raw(streamEventWire(msg.event))],
      ]);
    case "org_event":
      return JSON.stringify(frame("org_event", [["event", msg.event]]));
    case "subagent_tree":
      return JSON.stringify(
        frame("subagent_tree", [
          ["chat_id", msg.chat_id],
          ["nodes", msg.nodes],
        ]),
      );
    case "machine_status":
      return JSON.stringify(
        frame("machine_status", [
          ["machine_id", msg.machine_id],
          ["online", msg.online],
        ]),
      );
    case "archived_thread_list":
      return JSON.stringify(frame("archived_thread_list", [["chats", msg.chats]]));
    case "project_list":
      return JSON.stringify(
        frame("project_list", [
          ["projects", msg.projects],
          ["archived_projects", msg.archived_projects],
        ]),
      );
    case "machine_list":
      return JSON.stringify(frame("machine_list", [["machines", msg.machines]]));
    case "workspace_identity":
      return JSON.stringify(
        frame("workspace_identity", [
          ["name", msg.name],
          ["logo_url", msg.logo_url],
        ]),
      );
  }
}

/** Client → server (crates/protocol/src/ws.rs WsClientMsg). Parsing mirrors
 *  serde's defaults: absent optional fields become null/empty; unknown
 *  variants (and unparseable text) return null and are discarded by the
 *  reader without closing the socket. */
export type WsClientMsg =
  | { type: "sync"; chat_id: string | null }
  | { type: "ping" }
  | { type: "read"; chat_id: string }
  | {
      type: "machine_response";
      request_id: string;
      ok: boolean;
      payload?: unknown;
      error?: string;
    }
  | {
      type: "tool_result";
      chat_id: string;
      call_id: string;
      content: string;
      is_error: boolean;
      meta: unknown;
      images: string[];
    };

export function parseClientMsg(text: string): WsClientMsg | null {
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
