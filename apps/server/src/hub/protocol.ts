// Wire envelopes for the per-client WebSocket connection (crates/protocol/
// src/ws.rs). Every message is a JSON text frame tagged by `type`.
//
// Frames must be BYTE-compatible with the Rust server (shipped daemons never
// update): serde_json serializes an internally-tagged enum as the `type` tag
// first, then the variant's fields in declaration order, snake_case field
// names as declared, Option::None fields omitted (skip_serializing_if). We
// build plain objects with keys inserted in exactly that order —
// JSON.stringify preserves string-key insertion order.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Server → client. Returns the exact bytes serde_json::to_string would
 *  produce for each WsServerMsg variant. */
export type WsServerMsg =
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
      type: "live_frame";
      chat_id: string;
      generation_id: string;
      seq: number;
      machine_id: string | null;
      event: unknown;
    }
  | { type: "org_event"; event: unknown };

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
    case "thread_state":
      return JSON.stringify(
        frame("thread_state", [
          ["chat_id", msg.chat_id],
          ["seq", msg.seq],
          ["events", msg.events],
          ["text", msg.text],
          ["thinking", msg.thinking],
          ["generating", msg.generating],
          ["project_id", msg.project_id],
          ["project_name", msg.project_name],
          ["project_machine_label", msg.project_machine_label],
          ["has_more_events", msg.has_more_events],
        ]),
      );
    case "sync_done":
      return JSON.stringify(frame("sync_done", [["chat_id", msg.chat_id]]));
    case "live_frame":
      return JSON.stringify(
        frame("live_frame", [
          ["chat_id", msg.chat_id],
          ["generation_id", msg.generation_id],
          ["seq", msg.seq],
          ["machine_id", msg.machine_id],
          ["event", msg.event],
        ]),
      );
    case "org_event":
      return JSON.stringify(frame("org_event", [["event", msg.event]]));
  }
}

/** Client → server (crates/protocol/src/ws.rs WsClientMsg). Parsing mirrors
 *  serde's defaults: absent optional fields become null/empty; unknown
 *  variants (and unparseable text) return null and are discarded by the
 *  reader without closing the socket. */
export type WsClientMsg =
  | { type: "sync"; chat_id: string | null }
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
