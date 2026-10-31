// The member and machine socket frames, hand-written from
// protocol/socket.schema.json. The schema is the contract. Presence follows
// it exactly: an optional field is `field?: T`; an always-serialized nullable
// field is `field: T | null`; an always-serialized plain field is `field: T`.
//
// `Json`, `Chat`, `EventRow`, `MachineInfo`, `Project`, `SubagentNode`,
// `ThreadEventRow`, `ToolCall` and `ToolKind` live in ./rest.ts with the other
// REST types. They are re-exported here because the socket frames use them.

import type {
  Chat,
  EventRow,
  Json,
  MachineInfo,
  Project,
  SubagentNode,
  ThreadEventRow,
  ToolCall,
  ToolKind,
} from "./rest.js";

export type {
  Chat,
  EventRow,
  Json,
  MachineInfo,
  Project,
  SubagentNode,
  ThreadEventRow,
  ToolCall,
  ToolKind,
};

/** A JSON UUID string. */
export type Uuid = string;

/** The 11 stream event variants. `live_frame.event` carries one. */
export type StreamEvent =
  | { type: "delta"; content: string }
  | { type: "thinking_delta"; content: string }
  | { type: "idle" }
  | {
      type: "done";
      message_id: Uuid;
      cost_usd: number;
      tokens_in: number;
      tokens_out: number;
    }
  | { type: "error"; code: string; message: string }
  | {
      type: "tool_call_delta";
      index: number;
      id?: string;
      name?: string;
      arguments_delta: string;
    }
  | { type: "tool_call_done"; call: ToolCall }
  | {
      type: "tool_started";
      call_id: string;
      name: string;
      arguments: string;
      executor: "client" | "server";
      kind?: ToolKind;
    }
  | {
      type: "tool_completed";
      call_id: string;
      name: string;
      content: string;
      is_error: boolean;
    }
  | {
      type: "approval_requested";
      call_id: string;
      name: string;
      arguments: string;
    }
  | {
      type: "approval_resolved";
      call_id: string;
      approved: boolean;
      reason?: string;
    };

/** Server → client. */
export type ServerFrame =
  | { type: "hello" }
  | { type: "displaced" }
  | { type: "auth_required" }
  | {
      type: "tool_dispatch";
      chat_id: Uuid;
      call_id: string;
      name: string;
      arguments: string;
      workdir?: string;
    }
  | { type: "tool_cancel"; call_id: string }
  | { type: "error"; message: string }
  | {
      type: "machine_request";
      request_id: string;
      op: string;
      payload: Json;
    }
  | { type: "thread_list"; chats: Chat[] }
  | { type: "chat_status"; chat_id: Uuid; generating: boolean }
  | {
      type: "thread_events";
      chat_id: Uuid;
      seq: number;
      events: ThreadEventRow[];
    }
  | { type: "sync_begin"; chat_id: Uuid }
  | {
      type: "thread_state";
      chat_id: Uuid;
      seq: number;
      events: ThreadEventRow[];
      text: string;
      thinking: string;
      generating: boolean;
      project_id?: Uuid;
      project_name?: string;
      project_machine_label?: string;
      has_more_events: boolean;
    }
  | { type: "sync_done"; chat_id: Uuid }
  | { type: "pong" }
  | {
      type: "live_frame";
      chat_id: Uuid;
      generation_id: Uuid;
      seq: number;
      machine_id: string | null;
      event: StreamEvent;
    }
  | { type: "org_event"; event: EventRow }
  | { type: "subagent_tree"; chat_id: Uuid; nodes: SubagentNode[] }
  | { type: "machine_status"; machine_id: string; online: boolean }
  | { type: "archived_thread_list"; chats: Chat[] }
  | {
      type: "project_list";
      projects: Project[];
      archived_projects: Project[];
    }
  | { type: "machine_list"; machines: MachineInfo[] }
  | { type: "workspace_identity"; name: string; logo_url?: string; telemetry: boolean };

/** Client → server. */
export type ClientFrame =
  | { type: "ping" }
  | { type: "sync"; chat_id?: string | null }
  | { type: "read"; chat_id: Uuid }
  | {
      type: "machine_response";
      request_id: string;
      ok: boolean;
      payload?: Json;
      error?: string;
    }
  | {
      type: "tool_result";
      chat_id: Uuid;
      call_id: string;
      content: string;
      is_error: boolean;
      meta?: Json | null;
      images?: string[];
    };

/** Executor-owned context returned by the versioned `context.prepare_v1`
 *  machine operation. */
export interface MachineContext {
  /** Always present. null when unset. */
  instructions: string | null;
  skills_index: string;
  skill_expansions: string;
}
