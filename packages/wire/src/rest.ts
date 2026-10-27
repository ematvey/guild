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
