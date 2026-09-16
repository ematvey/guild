// Hand-written TS mirror of `crates/protocol/src/ws.rs` (keep in sync).
import type { JsonValue } from "./serde_json/JsonValue";
import type { StreamEvent } from "./StreamEvent";

/**
 * Client → server envelopes for the per-client WebSocket connection,
 * tagged by `type` (serde internally tagged, snake_case).
 */
export type WsClientMsg =
  | { "type": "sync", chat_id: string | null, }
  | { "type": "tool_result", chat_id: string, call_id: string, content: string, is_error: boolean, meta: JsonValue | null, };

/**
 * Server → client envelopes for the per-client WebSocket connection,
 * tagged by `type` (serde internally tagged, snake_case).
 */
export type WsServerMsg =
  | { "type": "hello", }
  | { "type": "displaced", }
  | { "type": "auth_required", }
  | { "type": "error", message: string, }
  | { "type": "thread_list", chats: JsonValue[], }
  | { "type": "chat_status", chat_id: string, generating: boolean, }
  | { "type": "sync_begin", chat_id: string, }
  | { "type": "history", chat_id: string, events: JsonValue[], }
  | { "type": "snapshot_frame", chat_id: string, machine_id: string | null, event: StreamEvent, }
  | { "type": "sync_done", chat_id: string, }
  | { "type": "live_frame", chat_id: string, machine_id: string | null, event: StreamEvent, }
  | { "type": "org_event", event: JsonValue, };
