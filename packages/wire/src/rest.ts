// The REST data-transfer types, hand-written from protocol/rest.schema.json.
// The schema is the contract. Presence follows it exactly: an optional field
// is `field?: T`; an always-serialized nullable field is `field: T | null`;
// an always-serialized plain field is `field: T`.
//
// `Json` is any JSON value. It is `unknown` on purpose: the value is opaque,
// and the reader narrows it.

/** Any JSON value. serde_json::Value in Rust. */
export type Json = unknown;

/** Coarse tool category the UI renders natively. */
export type ToolKind = "web_search" | "web_browse" | "generic";

/** One tool invocation requested by the model. */
export interface ToolCall {
  id: string;
  name: string;
  /** A JSON value, not a string. The raw string lives on `Block`. */
  arguments: Json;
}

/** One durable thread event. */
export type ThreadEvent =
  | {
      type: "user_message";
      content: string;
      attachments: MessageAttachment[];
      queued?: boolean;
      mode?: string;
    }
  | { type: "system_message"; content: string }
  | {
      type: "assistant_message";
      turn: number;
      step: number;
      blocks: Block[];
      usage: UsagePayload;
      model: string;
      /** Files this turn attached to the message (send_file). Omitted when
       *  empty. */
      attachments?: MessageAttachment[];
      interrupted?: boolean;
      error?: string;
    }
  | {
      type: "tool_result";
      turn: number;
      step: number;
      call_id: string;
      name: string;
      content: string;
      is_error: boolean;
      meta?: Json | null;
      images?: string[];
      kind?: ToolKind;
      artifact_id?: string;
    }
  | {
      type: "compaction";
      summary: string;
      tokens_before?: number;
      keep_last?: number;
      model?: string;
      usage?: UsagePayload;
    }
  | {
      type: "approval_request";
      call_id: string;
      name: string;
      arguments: string;
      judge?: JudgeVerdict;
    }
  | {
      type: "approval_decision";
      call_id: string;
      approved: boolean;
      reason?: string;
      expired?: boolean;
    }
  | { type: "turn_error"; message: string }
  | {
      type: "child_spawned";
      thread_id: string;
      run_id: string;
      chat_id: string;
      agent_name: string;
      title: string;
      status: string;
      task: string;
    }
  | {
      type: "child_result";
      thread_id: string;
      run_id: string;
      chat_id: string;
      agent_name: string;
      title: string;
      status: string;
      started_at?: string;
      reason?: string;
      final_text: string;
      attachments: MessageAttachment[];
    }
  | { type: "child_closed"; thread_id: string };

/** One persisted thread event as the store returns it: the durable log row
 *  that the member socket and the thread reads carry. */
export interface ThreadEventRow {
  id: string;
  chat_id: string;
  /** Monotonic per chat. The client's watermark. */
  seq: number;
  event: ThreadEvent;
  created_at: string;
}

/** One node of a chat's thread subtree, with its latest run status. */
export interface SubagentNode {
  thread_id: string;
  chat_id: string;
  /** Always serialized. null for a top-level thread. */
  parent_thread_id: string | null;
  agent_name: string;
  title: string;
  depth: number;
  /** Always serialized. null before the thread's first run. */
  status: string | null;
}

/** One org-scoped event row, as the `org_event` frame carries it. */
export interface EventRow {
  id: string;
  org_id: string;
  /** Selects the payload shape. */
  kind: string;
  /** Opaque here: the shape depends on `kind`. */
  payload: Json;
  created_at: string;
}

/** One typed block inside an assistant thread event, in stream order. */
export type Block =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      /** The RAW JSON string exactly as the model produced it. */
      arguments: string;
    };

/** The approval judge's verdict on one gated tool call. */
export interface JudgeVerdict {
  approve: boolean;
  reason?: string;
  /** Judge round-trip time in milliseconds. */
  ms?: number;
}

/** A file attached to a user turn. */
export interface MessageAttachment {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  /** `image`, `audio`, `video` or `document`. */
  modality: string;
}

/** Token accounting on an assistant thread event. */
export interface UsagePayload {
  tokens_in?: number;
  tokens_out?: number;
  cost_usd?: number;
}

/** A declared callable tool, with JSON Schema parameters. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Json;
  kind: ToolKind;
}

/** One model-facing message on the request and reply path. */
export interface Message {
  role: string;
  content: string;
  images?: string[];
  audio?: MessageAudio[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  reasoning?: string;
}

/** One audio part on a user turn (OpenAI `input_audio` contract). */
export interface MessageAudio {
  /** Raw base64, no `data:` prefix. */
  data: string;
  /** `wav` or `mp3`. */
  format: string;
}

/** One project: a named folder bound to a machine. */
export interface Project {
  id: string;
  name: string;
  /** Windows path; UNC (`\\wsl.localhost\…`) for a WSL distro folder. */
  folder: string;
  machine_id: string;
  /** Always serialized. null when unset. */
  machine_label: string | null;
  /** RFC 3339 timestamp. */
  created_at: string;
}

/** Creates a project: a named folder bound to a machine. `name` is optional:
 *  an absent or null label defaults to the folder's basename. */
export interface CreateProjectRequest {
  /** Omitted or null when unset. */
  name?: string | null;
  folder: string;
  machine_id: string;
}

/** A registry bundle manifest, shared by the hub and the machines. */
export interface BundleManifest {
  /** `skill`, `mcp` or `integration`. */
  kind: string;
  slug: string;
  version: string;
  description: string;
  dependencies: string[];
  mcp: McpManifest | null;
  auth: AuthManifest | null;
  settings: SettingsManifest | null;
  tools: ToolsManifest | null;
  triggers: TriggerSpec[];
  skills: string[];
}

/** A Streamable-HTTP MCP endpoint. */
export interface McpManifest {
  url: string;
}

/** One admin-facing configuration field. */
export interface FieldSpec {
  name: string;
  /** `string`, `text`, `number`, `boolean` or `secret`. */
  kind: string;
  label: string | null;
  required: boolean;
  default: Json | null;
  help: string | null;
  placeholder: string | null;
}

/** The typed settings schema of an integration. */
export interface SettingsManifest {
  fields: FieldSpec[];
}

/** The auth shape of an integration. */
export interface AuthManifest {
  /** `org_secret`, `org_secret_impersonated` or `per_user_token`. */
  kind: string;
  secret_names: string[];
  identity_key: string;
}

/** Per-tool class declarations from the connector. */
export interface ToolsManifest {
  classes: Record<string, string>;
}

/** A v1-compatible trigger descriptor. */
export interface TriggerSpec {
  /** `webhook` or `interval`. */
  kind: string;
  name: string | null;
  trigger_config: Json;
  prompt: string;
  model: string;
  allowed_tools: string[] | null;
}

// ---------------------------------------------------------------------------
// HTTP data-transfer types (protocol/rest.schema.json, from api.rs)
// ---------------------------------------------------------------------------

/** One chat row in the sidebar list. */
/** The three kinds of thread. Archiving and deletion are flags, not types. */
export type ThreadType = "user" | "subagent" | "routine";

export interface Chat {
  id: string;
  org_id: string;
  user_id: string;
  /** Omitted when unset. */
  title?: string;
  created_at: string;
  /** Bound executor machine. Omitted when unset. */
  machine_id?: string;
  machine_label?: string;
  /** A generation is in flight. */
  generating: boolean;
  /** An unseen assistant turn exists. */
  unread: boolean;
  /** This chat or a descendant thread has a queued or running run. */
  working: boolean;
  /** A tool call waits for the user's approval. */
  blocked: boolean;
  /** The latest thread event, falling back to created_at. */
  last_activity_at: string;
  /** Omitted when the chat is folderless. */
  project_id?: string;
  project_name?: string;
  project_machine_label?: string;
  /** The bound machine's socket is live now. */
  machine_online: boolean;
  /** What the chat's thread is. A chat with no thread row is a user chat. */
  type: ThreadType;
  /** The user hid the chat from the sidebar; it still resolves. */
  archived: boolean;
  /** The user removed the chat; it drops out of every list. */
  deleted: boolean;
}

/** The signed-in account. */
export interface UserInfo {
  id: string;
  email: string;
  org_id: string;
  role: string;
  /** Always present. null when unset. */
  display_name: string | null;
  /** Always present. null when unset. */
  avatar_url: string | null;
  /** The first-run guide was dismissed. */
  onboarded: boolean;
}

/** `POST /api/v1/auth/login` body. */
export interface LoginRequest {
  email: string;
  password: string;
}

/** `POST /api/v1/auth/login` answer. */
export interface LoginResponse {
  token: string;
  user: UserInfo;
}

/** Desktop pairing: the one-time code redeemed for a session. */
export interface PairRequest {
  code: string;
}

/** Desktop pairing answer. */
export interface PairResponse {
  token: string;
  user: UserInfo;
}

/** Mint a pairing code. */
export interface CreatePairingTokenRequest {
  /** Omitted when unset. Default 30, capped server-side. */
  ttl_minutes?: number;
}

/** A freshly minted pairing code. The secret is returned once. */
export interface PairingTokenResponse {
  id: string;
  secret: string;
  expires_at: string;
}

/** A live pairing code, without its secret. */
export interface PairingTokenInfo {
  id: string;
  created_at: string;
  expires_at: string;
}

/** `POST /api/v1/chats` body. */
export interface CreateChatRequest {
  title?: string;
  project_id?: string;
}

/** `PATCH /api/v1/chats/{id}` body. Only present fields change. */
export interface UpdateChatRequest {
  title?: string;
  archived?: boolean;
}

/** `PATCH /api/v1/projects/{id}` body. Only present fields change. */
export interface UpdateProjectRequest {
  name?: string;
  folder?: string;
  machine_id?: string;
  /** `false` unarchives. */
  archived?: boolean;
}

/** One machine-registry row joined with the hub's live socket state. */
export interface MachineInfo {
  machine_id: string;
  /** Hostname label; falls back to machine_id. */
  name: string;
  os?: string;
  os_version?: string;
  app_version?: string;
  /** Peer address of the last connect. */
  last_ip?: string;
  first_connected_at: string;
  last_connected_at: string;
  last_seen_at: string;
  /** The machine's singleton socket is live now. */
  connected: boolean;
}

/** `POST /api/v1/gateway/chat` body: the in-app turn submission. */
export interface ChatCompletionRequest {
  /** Stable identity for the committed user-message echo. */
  user_message_id?: string;
  chat_id: string;
  model: string;
  messages: Message[];
  /** Declared tools for this turn. */
  tools?: ToolSpec[];
  system?: string;
  /** The caller can execute machine tools. */
  client_tools: boolean;
  project_id?: string;
  /** Context attachments uploaded beforehand. Omitted when empty. */
  attachment_ids?: string[];
  /** Org workspace directory name for server-side execution. */
  server_workspace?: string;
  /** Client-discovered local-skills index. */
  skills_index?: string;
  /** Client-discovered AGENTS.md chain. */
  agents_md?: string;
  /** `queue` (default) or `steer`. */
  send_mode?: string;
}
