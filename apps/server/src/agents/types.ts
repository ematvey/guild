// Persistent agent rows and wire shapes. These names are the contract the
// agents lanes share; keep them stable.

import type { AgentThreadType } from "../platform/domain/thread-type.js";
import type { AgentIntegrationEntry } from "../platform/domain/integration-access.js";

export type { AgentThreadType };
export type AgentVisibility = "private" | "org";
/** An agent access role: `owner` manages and uses (the agent's owner and
 *  org admins), `editor` manages it through an `edit` entry, `user` uses it
 *  through a `read` entry or its org visibility. */
export type AgentRole = "owner" | "editor" | "user";
export type AgentStatus = "active" | "archived" | "deleting" | "deleted";

export type AgentRunStatus = "queued" | "running" | "succeeded" | "failed" | "silent" | "skipped" | "cancelled";
export type AgentTrigger = "message" | "routine" | "manual" | "delegation";
export type AgentRoutineKind = "cron" | "once";
export type AgentRoutineContext = "isolated";
/** Where a routine run's send_message lands: appended to the routine's one
 *  conversation with the user, or a new conversation per message. */
export type AgentRoutineDelivery = "thread" | "new_chat";
export type AgentRoutineOccurrenceStatus = "pending" | "claimed" | "done" | "failed" | "skipped";

/** Built-in agent tools. Integration/MCP tool names are added by the runtime
 *  on top of this union. */
export type AgentToolName =
  | "read"
  | "write"
  | "edit"
  | "list"
  | "bash"
  | "web_search"
  | "search_skills"
  | "read_skill"
  | "conversations_search"
  | "conversations_list"
  | "conversation_read"
  | "send_message"
  | "schedule_reminder"
  | "list_routines"
  | "create_routine"
  | "update_routine"
  | "delete_routine"
  | "subagents"
  | "send_file"
  | "publish_app"
  | "list_apps"
  | "read_app"
  | "call_app"
  | "set_app_access";

/** One entry of an agent's tool allowlist: a built-in tool or a Trait tool
 *  (`web_fetch`). Integration tools are not listed here. */
export type AgentToolRef = AgentToolName | (string & {});

/** Every built-in tool an agent can be given; `tools_mode = 'all'` means
 *  this set. Integrations are never covered by `all`: an agent lists them
 *  explicitly (`Agent.integrations`). */
export const ALL_AGENT_TOOLS: AgentToolName[] = [
  "read",
  "write",
  "edit",
  "list",
  "bash",
  "web_search",
  "search_skills",
  "read_skill",
  "conversations_search",
  "conversations_list",
  "conversation_read",
  "send_message",
  "schedule_reminder",
  "list_routines",
  "create_routine",
  "update_routine",
  "delete_routine",
  "subagents",
  "send_file",
  "publish_app",
  "list_apps",
  "read_app",
  "call_app",
  "set_app_access",
];

/** How an agent's tool allowlist is resolved. */
export type AgentToolsMode = "selected" | "all";

/** Longest accepted agent description, in characters. */
export const MAX_AGENT_DESCRIPTION_CHARS = 500;

export interface Agent {
  id: string;
  org_id: string;
  owner_user_id: string;
  owner_label?: string | null;
  owner_email?: string | null;
  owner_avatar_url?: string | null;
  name: string;
  /** What this agent is for; another agent reads it to pick a target. */
  description: string;
  model: string;
  /** The org's display name for the model ("Auto"); the id is the fallback. */
  model_alias?: string | null;
  tools: AgentToolRef[];
  /** `all` takes every built-in tool; `selected` uses `tools`. */
  tools_mode: AgentToolsMode;
  /** Replies may carry Generated UI blocks: the agent's instructions teach
   *  the component library, the client renders the blocks. */
  generative_ui: boolean;
  visibility: AgentVisibility;
  resources: Record<string, unknown>;
  status: AgentStatus;
  /** The user's personal agent: one per user, always private, never deleted. */
  is_personal: boolean;
  /** The viewer manages this agent: the owner, an admin, or an `edit` entry.
   *  Set by the viewer-scoped reads; false on org-wide rows. */
  can_manage: boolean;
  /** Teams granted this agent, at any level: the audience the Integration
   *  warnings read. */
  team_ids?: string[];
  /** The Integrations this agent's Turns see, each with its class ceiling. */
  integrations: AgentIntegrationEntry[];
  deleted_at: string | null;
  purge_after: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentThread {
  id: string;
  agent_id: string;
  /** The user whose private conversation this is. */
  user_id: string;
  /** The chat journal row that holds this thread's transcript. */
  chat_id: string;
  title: string;
  title_locked: boolean;
  type: AgentThreadType;
  /** The Main thread the agent was created with; only its creator has one. */
  is_default: boolean;
  /** The spawning thread, or null for a root thread. */
  parent_thread_id: string | null;
  /** The thread this one was opened from, or null when the user opened it.
   *  A message an agent delivers into a new thread carries the run thread
   *  here, so the agent can read that run and the client can link to it. */
  origin_thread_id: string | null;
  /** Real tree depth: a root is 0, its child is 1. */
  depth: number;
  /** Set when the node (or an ancestor) was closed; deliveries stop. */
  closed_at: string | null;
  created_at: string;
  last_activity_at: string;
}

export interface AgentRun {
  /** Internal coordination histories are not member-visible runs. */
  internal?: true;
  id: string;
  agent_id: string;
  /** The user on whose behalf the run happens. */
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
  /** Joined display names for activity and run detail; absent on bare rows. */
  agent_name?: string | null;
  routine_name?: string | null;
}

export interface AgentRoutine {
  id: string;
  agent_id: string;
  /** The user whose private threads this routine's runs produce. */
  created_by_user_id: string | null;
  name: string;
  kind: AgentRoutineKind;
  schedule: string | null;
  timezone: string;
  run_at: string | null;
  prompt: string;
  context: AgentRoutineContext;
  delivery: AgentRoutineDelivery;
  enabled: boolean;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
  /** Newest run for this routine, when the list is read through the store. */
  last_run?: AgentRun | null;
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
  type: "tool_call" | "assistant_text" | "user_message" | "file";
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
  "conversations_list",
  "conversation_read",
  "send_message",
  "schedule_reminder",
  "list_routines",
  "create_routine",
  "update_routine",
  "delete_routine",
];

/** One activity-log row: a run joined with its agent's display name. */
export interface AgentActivityEntry extends AgentRun {
  agent_name: string;
}
