// Persistent agent rows and wire shapes (docs/specs/2026-10-18-persistent-agents.md).
// These names are the contract the agents lanes share; keep them stable.

export type AgentVisibility = "private" | "team" | "org";
export type AgentRole = "owner" | "editor" | "user" | "viewer";
export type AgentStatus = "active" | "archived" | "deleting" | "deleted";
export type AgentThreadKind = "default" | "thread" | "routine_run";
export type AgentRunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "silent"
  | "skipped";
export type AgentTrigger = "message" | "routine" | "manual" | "delegation";
export type AgentRoutineKind = "cron" | "once";
export type AgentRoutineContext = "isolated";
export type AgentRoutineOccurrenceStatus =
  | "pending"
  | "claimed"
  | "done"
  | "failed"
  | "skipped";

/** Built-in agent tools. Integration/MCP tool names are added by the runtime
 *  on top of this union. */
export type AgentToolName =
  | "read"
  | "write"
  | "edit"
  | "list"
  | "bash"
  | "web_search"
  | "codemode"
  | "search_skills"
  | "read_skill"
  | "conversations_search"
  | "conversation_read"
  | "send_message"
  | "schedule_reminder"
  | "delegate"
  | "release_artifacts";

export interface Agent {
  id: string;
  org_id: string;
  owner_user_id: string;
  name: string;
  instructions: string;
  model: string;
  tools: AgentToolName[];
  visibility: AgentVisibility;
  resources: Record<string, unknown>;
  status: AgentStatus;
  deleted_at: string | null;
  purge_after: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentThread {
  id: string;
  agent_id: string;
  /** The chat journal row that holds this thread's transcript. */
  chat_id: string;
  title: string;
  title_locked: boolean;
  kind: AgentThreadKind;
  created_at: string;
  last_activity_at: string;
}

export interface AgentRun {
  id: string;
  agent_id: string;
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
}

export interface AgentRoutine {
  id: string;
  agent_id: string;
  name: string;
  kind: AgentRoutineKind;
  schedule: string | null;
  timezone: string;
  run_at: string | null;
  prompt: string;
  context: AgentRoutineContext;
  enabled: boolean;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentRoutineOccurrence {
  id: string;
  routine_id: string;
  scheduled_for: string;
  run_id: string | null;
  status: AgentRoutineOccurrenceStatus;
  attempts: number;
  last_error: string | null;
}

export interface AgentNotice {
  id: string;
  org_id: string;
  agent_id: string | null;
  user_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

/** One derived run-detail step: a tool call, an assistant text block, or a
 *  file touched by the run's workspace turn. */
export interface AgentRunStep {
  type: "tool_call" | "assistant_text" | "file";
  seq?: number;
  ts: string;
  text?: string;
  name?: string;
  call_id?: string;
  is_error?: boolean;
  paths?: string[];
}

/** The caller's effective access to one agent: the resolved grant role plus
 *  the two capability flags routes check. Admins resolve as `owner`. */
export interface AgentAccess {
  role: AgentRole | null;
  can_manage: boolean;
  can_use: boolean;
}

/** The tool baseline a new agent starts with (design decision 18). */
export const DEFAULT_AGENT_TOOLS: AgentToolName[] = [
  "read",
  "write",
  "list",
  "conversations_search",
  "conversation_read",
  "send_message",
  "schedule_reminder",
];

/** One activity-log row: a run joined with its agent's display name. */
export interface AgentActivityEntry extends AgentRun {
  agent_name: string;
}

/** One file a delegated child run declared for transfer into the parent. */
export type AgentArtifactStatus = "inbox" | "staged" | "released";

export interface AgentDelegationArtifact {
  id: string;
  run_id: string;
  parent_run_id: string;
  agent_id: string;
  /** Path relative to the child agent workspace. */
  path: string;
  size: number;
  status: AgentArtifactStatus;
  /** Path relative to the parent agent workspace when copied into its inbox. */
  inbox_path: string | null;
  /** Absolute staging path when the file is too large for the inbox copy. */
  staging_path: string | null;
  created_at: string;
}
