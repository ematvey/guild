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
      /** The message was posted into the thread outside a run (a Routine's
       *  `send_message`): a message of its own, not a step of a turn. */
      posted?: boolean;
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

// ---------------------------------------------------------------------------
// Agents, the thread tree and the skill catalog: the rows the agent, run,
// routine, chat-tree and skill-catalog socket frames carry.
// ---------------------------------------------------------------------------

// `team` is retired: the server never writes it, and a client that still
// knows it renders it. It leaves the enum when no shipped client predates
// 0.6.86.
// coherence:seam owner=@maintainer until=2027-06-01 reason="shipped clients carry the team visibility"
export type AgentVisibility = "private" | "team" | "org";
export type AgentStatus = "active" | "archived" | "deleting" | "deleted";
export type AgentRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "silent"
  | "skipped"
  | "cancelled";
export type AgentTrigger = "message" | "routine" | "manual" | "delegation";

/** One persistent agent as its viewers see it. */
export interface Agent {
  id: string;
  org_id: string;
  owner_user_id: string;
  /** The owner's display name or email. */
  owner_label: string | null;
  owner_email: string | null;
  owner_avatar_url: string | null;
  name: string;
  /** What the agent is for; at most 500 characters. */
  description: string;
  model: string;
  /** The org's display name for the model; null falls back to the id. */
  model_alias: string | null;
  tools: string[];
  tools_mode: "selected" | "all";
  /** Replies may carry Generated UI (`openui` blocks) the client renders
   *  as components. */
  generative_ui: boolean;
  visibility: AgentVisibility;
  /** The agent's sandbox budget. */
  resources: Json;
  status: AgentStatus;
  /** The user's personal agent: always private, never deleted. */
  is_personal: boolean;
  /** The viewer manages this agent: the owner, an admin, or an `edit` entry.
   *  False on rows built for the whole org. */
  can_manage: boolean;
  /** Teams granted this agent, at any level: the audience the Integration
   *  warnings read. */
  team_ids: string[];
  /** The Integrations the agent's Turns see, each with its class ceiling.
   *  Integrations are never implied by `tools_mode`. */
  integrations: AgentIntegration[];
  /** Where the agent gives someone more of an Integration than the
   *  Integration's audience grants them. */
  integration_warnings: IntegrationWarning[];
  deleted_at: string | null;
  purge_after: string | null;
  created_at: string;
  updated_at: string;
}

/** A tool's risk class: read < write < admin. */
export type ToolClass = "read" | "write" | "admin";

/** One entry of an agent's Integration list. */
export interface AgentIntegration {
  slug: string;
  ceiling: ToolClass;
}

/** One subject the agent gives more of an Integration than the
 *  Integration's audience grants them. */
export interface IntegrationWarning {
  integration: string;
  subject: "org" | "team" | "member";
  subject_id: string | null;
  subject_label: string;
  ceiling: ToolClass;
  granted: ToolClass | null;
}

/** An Integration the member may add to an agent they manage, with the
 *  highest class they may give. */
export interface AttachableIntegration {
  slug: string;
  title: string;
  summary: string;
  enabled: boolean;
  ceiling: ToolClass;
}

/** One durable transcript step in a Run detail. */
export interface AgentRunStep {
  kind: string;
  name?: string | null;
  status?: string | null;
  detail?: string | null;
  at?: string | null;
  call_id?: string | null;
  is_error?: boolean | null;
}

/** Number of messages in the newest Activity Conversation page. */
export const ACTIVITY_CONVERSATION_PAGE = 200;

export interface ConversationOwner {
  id: string;
  email: string;
  display_name: string | null;
}

export interface ConversationAgent {
  id: string;
  name: string;
}

export interface ConversationThread {
  id: string;
  /** The chat journal that holds the thread's transcript. */
  chat_id: string;
  type: string;
  parent_thread_id: string | null;
  parent_chat_id: string | null;
  parent_title: string | null;
}

export interface ConversationRow {
  internal?: boolean;
  id: string;
  title: string | null;
  owner: ConversationOwner;
  agent: ConversationAgent | null;
  thread: ConversationThread | null;
  created_at: string;
  last_activity_at: string;
  messages: number;
  runs: number;
  open_runs: number;
  failed_runs: number;
  archived: boolean;
  deleted: boolean;
}

export interface ConversationRunRow {
  id: string;
  agent_id: string;
  agent_name: string;
  trigger: string;
  status: string;
  summary: string;
  error_message: string;
  tokens: number;
  started_at: string;
  finished_at: string | null;
}

export interface ConversationMessageItem {
  kind: "message";
  seq: number;
  role: "user" | "assistant" | "system" | "error" | "compaction";
  text: string;
  ts: string;
}

export interface ConversationRunItem {
  kind: "run";
  ts: string;
  run: ConversationRunRow;
  /** The user message that started the run, when the page holds it. */
  trigger: string | null;
  /** Model and tool calls in the run, from the trace store. */
  steps: number;
  call_count: number;
  tool_count: number;
  /** True when an assistant message inside the run window follows the row:
   *  the reply renders there, so the row does not repeat it. */
  reply: boolean;
}

export type ConversationMessageRow = Omit<ConversationMessageItem, "kind">;

export type ConversationItem = ConversationMessageItem | ConversationRunItem;

export interface ConversationSnapshot {
  related_threads?: { id: string; title: string | null; internal: boolean }[];
  conversation: ConversationRow;
  items: (ConversationMessageItem | ConversationRunItem)[];
  /** True when an older page of messages exists. */
  has_more: boolean;
}

/** One agent run. `agent_name` and `routine_name` are joined display names. */
export interface AgentRun {
  /** The Run belongs to a background Thread visible in admin Activity. */
  internal?: boolean;
  id: string;
  agent_id: string;
  user_id: string | null;
  thread_id: string | null;
  routine_id: string | null;
  parent_run_id: string | null;
  delegate_agent_id: string | null;
  depth: number;
  trigger: AgentTrigger;
  status: AgentRunStatus;
  summary: string | null;
  error_code: string | null;
  error_message: string | null;
  error_step: string | null;
  tokens: number;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  agent_name: string | null;
  routine_name: string | null;
  /** Model calls the run made; present on a finished run's `agent_run` frame. */
  call_count?: number;
  /** Tool calls the run made; present on a finished run's `agent_run` frame. */
  tool_count?: number;
}

/** One of the caller's threads with an agent, with its chat's flags. */
export interface CoordinationOutcome {
  id: string;
  kind: string;
  source_name: string | null;
  source_key: string | null;
  created_at: string;
  delivered_at: string | null;
  reply_queued: boolean;
  reply_missing: boolean;
  reply_delivered_at: string | null;
  reply_failed_at: string | null;
  decision: string | null;
  decision_reason: string | null;
  matched_rule: string | null;
  accepted_scope: string | null;
  launched_run_id: string | null;
  launch_error: string | null;
  run_status: string | null;
  work_report_state: string | null;
  work_report_summary: string | null;
  work_report_question: string | null;
  source_chat_id: string | null;
  worker_chat_id: string | null;
  owned: boolean;
  retryable: boolean;
}

export interface CoordinationSnapshot {
  unavailable?: boolean;
  paused: boolean;
  outcomes: CoordinationOutcome[];
}

export interface AgentThread {
  id: string;
  agent_id: string;
  user_id: string;
  /** The chat journal that holds the thread's transcript. */
  chat_id: string;
  title: string;
  title_locked: boolean;
  type: ThreadType;
  /** False for every thread. The wire keeps the field for clients built
   *  before a thread stopped being its agent's default. */
  is_default: boolean;
  parent_thread_id: string | null;
  /** The run thread this one was opened from, when an agent delivered it. */
  origin_thread_id: string | null;
  depth: number;
  closed_at: string | null;
  created_at: string;
  last_activity_at: string;
  archived: boolean;
  deleted: boolean;
}

/** One routine of an agent with its newest run. */
export interface AgentRoutine {
  id: string;
  agent_id: string;
  created_by_user_id: string | null;
  name: string;
  kind: "cron" | "once";
  /** The cron expression; null for a one-shot routine. */
  schedule: string | null;
  timezone: string;
  run_at: string | null;
  prompt: string;
  context: "isolated";
  /** Where a run's send_message lands: `thread` appends to the routine's one
   *  conversation per user; `new_chat` opens a conversation per message. */
  delivery: "thread" | "new_chat";
  enabled: boolean;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
  /** The routine's newest run; null before the first. */
  last_run: AgentRun | null;
}

/** A chat the tree header links to: the parent or the origin thread. */
export interface ChatTreeLink {
  chat_id: string;
  title: string;
}

/** One chat's place in the thread tree. A chat with no thread row is a
 *  plain user chat. */
export interface ChatTree {
  chat_id: string;
  type: ThreadType;
  title: string;
  agent_id: string | null;
  agent_name: string | null;
  /** The thread's latest run status; null before its first run. */
  status: string | null;
  depth: number;
  parent: ChatTreeLink | null;
  origin: ChatTreeLink | null;
  archived: boolean;
  deleted: boolean;
  /** The receiving user owns the chat and may write to it; false for a
   *  chat an admin reads. */
  own: boolean;
}

/** The owner a skill is listed under: a user or a team. */
export interface SkillOwner {
  kind: "user" | "team";
  id: string;
  /** A user's display name or email; a team's name. */
  label: string;
  /** The owner user's avatar; null for teams and unset avatars. */
  avatar_url: string | null;
}

/** One entry of the org skill catalog. */
/** One parameter a page may pass to an App's data function. */
export interface AppParam {
  type: "string" | "number" | "integer" | "boolean";
  description?: string;
  enum?: (string | number)[];
  default?: string | number | boolean;
  required?: boolean;
  max_length?: number;
  minimum?: number;
  maximum?: number;
}

/** One named data function of an App: one Integration tool with fixed
 *  arguments and `{"$param": name}` holes. */
export interface AppFunction {
  name: string;
  description: string;
  integration: string;
  tool: string;
  args: { [key: string]: Json };
  params: { [name: string]: AppParam };
  /// What this call can do, when the tool's class cannot say it: a raw
  /// `<slug>_api` tool is class write because the whole API is, and one fixed
  /// request inside it may only read. Absent means the tool's class.
  class?: "read" | "write" | "admin";
}

/** Who one entry of an item's access list names, and at which level. */
export type AccessSubjectKind = "org" | "team" | "user";
export type AccessLevel = "read" | "edit";

/** One entry of an Agent's or an App's access list. `subject_id` is null for
 *  the org entry. */
export interface AccessEntry {
  subject_kind: AccessSubjectKind;
  subject_id: string | null;
  subject_label: string;
  level: AccessLevel;
}

/** An item's access list as the viewer may read it. */
export interface AccessList {
  entries: AccessEntry[];
  can_edit: boolean;
}

/** One member an access picker offers. */
export interface AccessPerson {
  id: string;
  label: string;
  avatar_url: string | null;
}

/** One team an access picker offers. */
export interface AccessTeam {
  id: string;
  label: string;
}

/** One App as lists carry it: everything but the page. */
export interface App {
  id: string;
  org_id: string;
  owner_user_id: string;
  owner_label: string;
  agent_id: string | null;
  agent_name: string | null;
  chat_id: string | null;
  name: string;
  description: string;
  visibility: "private" | "org";
  /** The viewer manages this app: its owner, an admin, or an `edit` entry. */
  can_edit: boolean;
  version: number;
  functions: AppFunction[];
  created_at: string;
  updated_at: string;
}

export interface SkillCatalogItem {
  slug: string;
  description: string;
  latest_version: string | null;
  owner: SkillOwner | null;
  maintainer_gated: boolean;
  installs: number;
  /** Installs that follow or pin the latest version. */
  installs_latest: number;
  tombstoned: boolean;
}

/** The caller's install record for one skill. */
export interface SkillInstall {
  slug: string;
  /** The pinned version; null follows the latest. */
  pinned_version: string | null;
  installed_at: string;
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
  pinned_at?: string;
  pin_rank?: number;
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
  /** Markdown: where an admin gets this value. Omitted when unset. */
  obtain?: string;
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
/** One declared tool of a code plugin, as its landing page lists it. */
export interface DeclaredTool {
  name: string;
  /** `read`, `write` or `admin`. */
  class: string;
  description: string;
}

export interface ToolsManifest {
  classes: Record<string, string>;
  /** The declared tools with their descriptions. Omitted when empty. */
  declared?: DeclaredTool[];
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
  pinned_at?: string;
  pin_rank?: number;
  /** Persistent Assistant inbox; pinned separately from ordinary Threads. */
  assistant_inbox?: boolean;
  shared_agent_inbox?: boolean;
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
  /** The routine whose output this chat is (the sidebar's routine mark).
   *  Omitted for any other chat, and once the routine is deleted. */
  routine?: ChatRoutine;
}

/** The routine a chat collects output from. */
export interface ChatRoutine {
  id: string;
  name: string;
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
  pinned?: boolean;
  title?: string;
  archived?: boolean;
}

/** `PATCH /api/v1/projects/{id}` body. Only present fields change. */
export interface UpdateProjectRequest {
  pinned?: boolean;
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
