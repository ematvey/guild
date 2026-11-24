// The member and machine socket frames, hand-written from
// protocol/socket.schema.json. The schema is the contract. Presence follows
// it exactly: an optional field is `field?: T`; an always-serialized nullable
// field is `field: T | null`; an always-serialized plain field is `field: T`.
//
// `Json`, `Chat`, `EventRow`, `MachineInfo`, `Project`, `SubagentNode`,
// `ThreadEventRow`, `ToolCall` and `ToolKind` live in ./rest.ts with the other
// REST types. They are re-exported here because the socket frames use them.

import type {
  Agent,
  App,
  AttachableIntegration,
  AgentRoutine,
  AgentRun,
  ConversationSnapshot,
  AgentRunStep,
  AgentThread,
  Chat,
  ChatTree,
  EventRow,
  Json,
  MachineInfo,
  MessageAttachment,
  Project,
  SkillCatalogItem,
  SkillInstall,
  SubagentNode,
  ThreadEventRow,
  ToolCall,
  ToolKind,
  UserInfo,
} from "./rest.js";

export type { Chat, EventRow, Json, MachineInfo, Project, SubagentNode, ThreadEventRow, ToolCall, ToolKind };

/** A JSON UUID string. */
export type Uuid = string;

/** How clients treat a remote image in agent content. */
export type RemoteImagesPolicy = "auto" | "click" | "never";

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

/** One input waiting in a chat's queue (ThreadState `queue`). `id` is a
 *  member message's message id, or `submission:<n>` for any other input. */
export interface QueuedInput {
  id: string;
  kind: "message" | "turn" | "child_result";
  mode: "steer" | "queue";
  text: string;
  attachments: MessageAttachment[];
}

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
      /** True while a compaction of the chat's context runs. Absent from
       *  servers that do not report it. */
      compacting?: boolean;
      /** The chat's inputs waiting for the agent, in placement order. A
       *  row reaches `events` only once its input is taken. Absent from
       *  servers that do not report it. */
      queue?: QueuedInput[];
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
  | {
      type: "workspace_identity";
      name: string;
      logo_url?: string;
      telemetry: boolean;
      /** Admin policy for remote images in agent content; absent from
       *  older servers, read as `auto`. */
      remote_images?: RemoteImagesPolicy;
      /** The served web bundle's identity; absent when none is served. */
      web_bundle?: string;
      /** The running server image's product/build version. */
      server_version?: string;
    }
  | { type: "model_list"; models: ModelOption[] }
  /** The member's own account; sent on connect and whenever its role,
   *  name, avatar or onboarding flag changes. */
  | { type: "member_profile"; user: UserInfo }
  | { type: "agent_list"; agents: Agent[] }
  /** The Integrations the member may add to an agent they manage. */
  | { type: "integration_access"; integrations: AttachableIntegration[] }
  | { type: "agent_run"; run: AgentRun }
  | {
      type: "activity_run";
      run: AgentRun;
      /** Durable steps appear only on the socket watching this Run. */
      steps?: AgentRunStep[];
      counts: { runs: number; open_runs: number; failed_runs: number } | null;
    }
  | { type: "activity_conversation"; chat_id: Uuid; detail: ConversationSnapshot | null }
  | { type: "agent_threads"; agent_id: Uuid; threads: AgentThread[] }
  | { type: "agent_routines"; agent_id: Uuid; routines: AgentRoutine[] }
  | { type: "skill_catalog"; items: SkillCatalogItem[]; installs: SkillInstall[] }
  /** The Apps the member sees: their own and those shared with the org. */
  | { type: "app_list"; apps: App[] }
  | { type: "chat_tree"; chat_id: Uuid; tree: ChatTree }
  /** One active-list row changed in place: replace it by id. Sent only to
   *  sockets that connected with `features=chat_row`. */
  | { type: "chat_row"; chat: Chat }
  /** One chat's context usage: its last completed request's tokens and the
   *  model it ran on. */
  | {
      type: "context_usage";
      chat_id: Uuid;
      tokens: number | null;
      usage_model: string | null;
      usage_model_alias: string | null;
    };

/** One enabled chat model: the route id and the admin's display name
 *  (empty when unnamed). */
export interface ModelOption {
  id: string;
  alias: string;
  /** The model's context window in tokens; absent from servers that do
   *  not report it. */
  context_window?: number;
}

/** Client → server. */
export type ClientFrame =
  | { type: "ping" }
  | { type: "sync"; chat_id?: string | null; run_id?: Uuid; activity_chat_id?: Uuid }
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
