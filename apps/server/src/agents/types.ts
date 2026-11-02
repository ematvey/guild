// Persistent agent rows and wire shapes (docs/specs/2026-10-18-persistent-agents.md).
// These names are the contract the agents lanes share; keep them stable.

import type { AgentThreadType } from "../platform/domain/thread-type.js";

export type { AgentThreadType };
export type AgentVisibility = "private" | "team" | "org";
/** An agent access role: `owner` manages and uses (the agent's owner and
 *  org admins), `user` uses (a direct or team grant). Grant rows store
 *  `user`; any other stored role grants nothing. */
export type AgentRole = "owner" | "user";

/** The one role a grant row confers. */
export const GRANT_ROLE = "user" satisfies AgentRole;
export type AgentStatus = "active" | "archived" | "deleting" | "deleted";

export type AgentRunStatus = "queued" | "running" | "succeeded" | "failed" | "silent" | "skipped" | "cancelled";
export type AgentTrigger = "message" | "routine" | "manual" | "delegation";
export type AgentRoutineKind = "cron" | "once";
export type AgentRoutineContext = "isolated";
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
  | "send_file";

/** One entry of an agent's tool allowlist: a built-in tool, or an
 *  integration/MCP tool name the runtime resolves at turn time. */
export type AgentToolRef = AgentToolName | (string & {});

/** Every tool an agent can be given. `tools_mode = 'all'` means this set,
 *  plus every integration tool the org enables (resolved at turn time, so a
 *  new integration reaches the agent without an edit). */
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
  /** `all` follows the org's enabled tools; `selected` uses `tools`. */
  tools_mode: AgentToolsMode;
  visibility: AgentVisibility;
  resources: Record<string, unknown>;
  status: AgentStatus;
  /** The user's personal agent: one per user, always private, never deleted. */
  is_personal: boolean;
  /** Teams granted use of a `team`-visibility agent. */
  team_ids?: string[];
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
  /** The user's Main thread with this agent; one per (agent, user). */
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
