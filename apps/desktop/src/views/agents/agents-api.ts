// Client for the persistent-agents API (docs/specs/2026-10-18-persistent-
// agents.md, "API surface"). Shapes mirror the design's data model; every
// response is the server's keyed envelope (`{agents: [...]}`, `{agent}`).

import { request, requestResponse } from "../../lib/api/request";
import type {
  AgentStatus,
  AgentVisibility,
  RunStatus,
  RunTrigger,
} from "./agents-route";

/** Authed binary/blob request (file preview and download). */
export function agentFileResponse(path: string): Promise<Response> {
  return requestResponse("GET", path);
}

export interface Agent {
  id: string;
  org_id: string;
  owner_user_id: string;
  owner_label?: string | null;
  owner_email?: string | null;
  owner_avatar_url?: string | null;
  name: string;
  /** How another agent identifies what this agent is for; at most 500 chars. */
  description: string;
  model: string;
  /** The org's display name for the model ("Auto"); the id is the fallback. */
  model_alias?: string | null;
  tools: string[];
  /** `all` follows the org's enabled tools; `selected` uses `tools`. */
  tools_mode?: "selected" | "all";
  visibility: AgentVisibility;
  resources?: unknown;
  status: AgentStatus;
  /** The user's personal agent: always private, never deleted. */
  is_personal?: boolean;
  team_ids?: string[];
  deleted_at?: string | null;
  purge_after?: string | null;
  created_at: string;
  updated_at: string;
  last_activity_at?: string | null;
  unread?: boolean;
}

export interface AgentThread {
  id: string;
  agent_id: string;
  /** The durable chat journal this thread projects into. Agent threads are
   *  chats; the transcript and send pipeline use this id. */
  chat_id: string;
  title: string;
  title_locked: boolean;
  type: "user" | "subagent" | "routine";
  /** The user's Main thread with this agent. */
  is_default: boolean;
  /** The run thread this one was opened from, when an agent delivered it. */
  origin_thread_id?: string | null;
  created_at: string;
  last_activity_at: string;
  unread?: boolean;
}

export interface AgentRunStep {
  kind: string;
  name?: string | null;
  status?: string | null;
  detail?: string | null;
  at?: string | null;
  call_id?: string | null;
  is_error?: boolean | null;
}

export interface AgentRun {
  id: string;
  agent_id: string;
  agent_name?: string | null;
  user_id?: string | null;
  thread_id?: string | null;
  chat_id?: string | null;
  routine_id?: string | null;
  routine_name?: string | null;
  parent_run_id?: string | null;
  delegate_agent_id?: string | null;
  depth: number;
  trigger: RunTrigger;
  status: RunStatus;
  summary?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  error_step?: string | null;
  tokens?: number | null;
  started_at?: string | null;
  finished_at?: string | null;
  created_at: string;
  steps?: AgentRunStep[];
  files?: string[];
}

export interface AgentRoutine {
  id: string;
  agent_id: string;
  name: string;
  kind: "cron" | "once";
  schedule: string | null;
  timezone: string;
  run_at?: string | null;
  prompt: string;
  context: "isolated";
  enabled: boolean;
  next_run_at?: string | null;
  created_at: string;
  updated_at: string;
  last_run?: AgentRun | null;
}

export interface AgentRoutineOccurrence {
  id: string;
  routine_id: string;
  scheduled_for: string;
  run_id?: string | null;
  status: "pending" | "claimed" | "done" | "failed" | "skipped";
  attempts: number;
  last_error?: string | null;
}

export interface AgentFileEntry {
  name: string;
  path: string;
  kind: "file" | "dir" | "symlink";
  size: number | null;
  mtime: string | null;
  symlink?: boolean;
  hidden?: boolean;
}

export interface AgentDirListing {
  path: string;
  entries: AgentFileEntry[];
  /** Present when the requested path named a file; `path` is then its parent. */
  file?: string;
}

export interface AgentToolInfo {
  name: string;
  label: string;
  group: string;
  description: string;
  safe: boolean;
}

export interface CreateAgentInput {
  name: string;
  description?: string;
  model: string;
  /** The org's display name for the model ("Auto"); the id is the fallback. */
  model_alias?: string | null;
  tools: string[];
  /** `all` follows the org's enabled tools; `selected` uses `tools`. */
  tools_mode?: "selected" | "all";
  visibility: AgentVisibility;
  team_ids?: string[];
}

export interface UpdateAgentInput {
  name?: string;
  description?: string;
  model?: string;
  tools?: string[];
  /** `all` follows the org's enabled tools; `selected` uses `tools`. */
  tools_mode?: "selected" | "all";
  visibility?: AgentVisibility;
  team_ids?: string[];
}

export interface RoutineInput {
  name: string;
  kind: "cron" | "once";
  schedule: string | null;
  timezone: string;
  run_at?: string | null;
  prompt: string;
  enabled: boolean;
}

export interface AgentFileContent {
  text?: string;
  language?: string | null;
  content_type?: string | null;
  size?: number | null;
  truncated?: boolean;
}

const agentBase = (id: string) => `/api/v1/agents/${encodeURIComponent(id)}`;

export async function listAgents(includeArchived = false): Promise<Agent[]> {
  const query = includeArchived ? "?include_archived=1" : "";
  return (await request<{ agents: Agent[] }>("GET", `/api/v1/agents${query}`)).agents;
}

export async function getAgent(id: string): Promise<Agent> {
  return (await request<{ agent: Agent }>("GET", agentBase(id))).agent;
}

export interface TeamOption {
  id: string;
  name: string;
}

export async function listMyTeams(): Promise<TeamOption[]> {
  const body = await request<{ teams: TeamOption[] }>("GET", "/api/v1/skills/teams");
  return body.teams;
}

export async function createAgent(input: CreateAgentInput): Promise<Agent> {
  return (await request<{ agent: Agent }>("POST", "/api/v1/agents", input)).agent;
}

export async function updateAgent(
  id: string,
  input: UpdateAgentInput,
): Promise<Agent> {
  return (await request<{ agent: Agent }>("PATCH", agentBase(id), input)).agent;
}

export async function archiveAgent(id: string): Promise<Agent> {
  return (await request<{ agent: Agent }>("POST", `${agentBase(id)}/archive`)).agent;
}

export async function restoreAgent(id: string): Promise<Agent> {
  return (await request<{ agent: Agent }>("POST", `${agentBase(id)}/restore`)).agent;
}

export async function exportAgent(id: string): Promise<unknown> {
  const body = await request<{ export: unknown }>("GET", `${agentBase(id)}/export`);
  return body.export;
}

export async function purgeAgent(id: string, force = false): Promise<void> {
  await request<{ purged: boolean }>("POST", `${agentBase(id)}/purge${force ? "?force=1" : ""}`);
}

export async function deleteAgent(id: string): Promise<void> {
  await request<void>("DELETE", agentBase(id));
}

export async function listAgentThreads(id: string): Promise<AgentThread[]> {
  return (await request<{ threads: AgentThread[] }>("GET", `${agentBase(id)}/threads`)).threads;
}

export async function getAgentThread(
  id: string,
  threadId: string,
): Promise<AgentThread> {
  return (await request<{ thread: AgentThread }>("GET", `${agentBase(id)}/threads/${encodeURIComponent(threadId)}`)).thread;
}


export type ChildThreadAction = "cancel" | "close";

export type ChildThreadActionResult =
  | { ok: true }
  | { ok: false; unavailable: true }
  | { ok: false; unavailable: false; error: string };


export async function createAgentThread(
  id: string,
  title?: string,
): Promise<AgentThread> {
  return (await request<{ thread: AgentThread }>("POST", `${agentBase(id)}/threads`, title ? { title } : {})).thread;
}

/** Sends one message into an agent thread. The server may stream SSE; this
 *  client consumes the stream to completion and the durable thread events
 *  arrive on the member socket. */
export async function sendAgentTurn(
  id: string,
  input: {
    thread_id?: string;
    message: string;
    attachment_ids?: string[];
    user_message_id?: string;
    send_mode?: "queue" | "steer";
  },
): Promise<void> {
  const res = await requestResponse("POST", `${agentBase(id)}/turns`, {
    body: JSON.stringify(input),
    headers: {
      "content-type": "application/json",
      accept: "text/event-stream, application/json",
    },
  });
  // Drain an SSE body so the server-side turn settles; JSON responses have
  // no body to drain.
  const reader = res.body?.getReader();
  if (reader) {
    while (!(await reader.read()).done) {
      // Frames are rendered from the durable socket lane.
    }
  }
}

export async function listAgentRuns(id: string): Promise<AgentRun[]> {
  return (await request<{ runs: AgentRun[] }>("GET", `${agentBase(id)}/runs`)).runs;
}

export async function getRun(runId: string): Promise<AgentRun> {
  return (await request<{ run: AgentRun }>("GET", `/api/v1/runs/${encodeURIComponent(runId)}`)).run;
}

export async function listRunChildren(runId: string): Promise<AgentRun[]> {
  const body = await request<{ children: AgentRun[] }>("GET", `/api/v1/runs/${encodeURIComponent(runId)}/children`);
  return body.children;
}

export interface ActivityFilters {
  agent?: string;
  status?: RunStatus | "all";
  trigger?: RunTrigger | "all";
}

export async function listActivity(
  filters: ActivityFilters = {},
): Promise<AgentRun[]> {
  const query = new URLSearchParams();
  if (filters.agent) query.set("agent", filters.agent);
  if (filters.status && filters.status !== "all")
    query.set("status", filters.status);
  if (filters.trigger && filters.trigger !== "all")
    query.set("trigger", filters.trigger);
  const suffix = query.toString() ? `?${query}` : "";
  return (await request<{ activity: AgentRun[] }>("GET", `/api/v1/activity${suffix}`)).activity;
}

export async function listRoutines(id: string): Promise<AgentRoutine[]> {
  return (await request<{ routines: AgentRoutine[] }>("GET", `${agentBase(id)}/routines`)).routines;
}

export async function getRoutine(
  id: string,
  routineId: string,
): Promise<AgentRoutine> {
  return (await request<{ routine: AgentRoutine }>("GET", `${agentBase(id)}/routines/${encodeURIComponent(routineId)}`)).routine;
}

export async function createRoutine(
  id: string,
  input: RoutineInput,
): Promise<AgentRoutine> {
  return (await request<{ routine: AgentRoutine }>("POST", `${agentBase(id)}/routines`, input)).routine;
}

export async function updateRoutine(
  id: string,
  routineId: string,
  input: Partial<RoutineInput>,
): Promise<AgentRoutine> {
  return (await request<{ routine: AgentRoutine }>("PATCH", `${agentBase(id)}/routines/${encodeURIComponent(routineId)}`, input)).routine;
}

export async function deleteRoutine(
  id: string,
  routineId: string,
): Promise<void> {
  await request<void>("DELETE", `${agentBase(id)}/routines/${encodeURIComponent(routineId)}`);
}

export async function runRoutine(
  id: string,
  routineId: string,
): Promise<AgentRun> {
  return (
    await request<{ run: AgentRun }>(
      "POST",
      `${agentBase(id)}/routines/${encodeURIComponent(routineId)}/run`,
    )
  ).run;
}

export async function listRoutineRuns(
  id: string,
  routineId: string,
): Promise<AgentRun[]> {
  return (await request<{ runs: AgentRun[] }>("GET", `${agentBase(id)}/routines/${encodeURIComponent(routineId)}/runs`)).runs;
}

export async function listAgentFiles(
  id: string,
  path: string,
  hidden = false,
): Promise<AgentFileEntry[]> {
  return (await listAgentDir(id, path, hidden)).entries;
}

/** One listing request for any path. A file path answers with its parent
 *  folder's entries plus `file`, so a file deep link needs no second call. */
export async function listAgentDir(
  id: string,
  path: string,
  hidden = false,
): Promise<AgentDirListing> {
  const query = new URLSearchParams({ path });
  if (hidden) query.set("hidden", "1");
  return request<AgentDirListing>("GET", `${agentBase(id)}/files?${query}`);
}

export async function getAgentFileContent(
  id: string,
  path: string,
): Promise<AgentFileContent> {
  const query = new URLSearchParams({ path });
  return request<AgentFileContent>("GET", `${agentBase(id)}/files/content?${query}`);
}

export function agentFileContentUrl(id: string, path: string): string {
  return `${agentBase(id)}/files/content?${new URLSearchParams({ path })}`;
}

export function agentFileDownloadUrl(id: string, path: string): string {
  return `${agentBase(id)}/files/download?${new URLSearchParams({ path })}`;
}

/** The org's tool catalog. Servers that predate the endpoint answer 404;
 *  the caller falls back to the safe baseline so creation still works. */
export async function listAgentTools(): Promise<AgentToolInfo[]> {
  return (await request<{ tools: AgentToolInfo[] }>("GET", "/api/v1/agents/tools")).tools;
}

/** The spec's safe baseline: workspace read/write/list, conversation search,
 *  send_message and schedule_reminder. */
export const SAFE_BASELINE_TOOLS: AgentToolInfo[] = [
  {
    name: "read",
    label: "Read file",
    group: "Workspace",
    description: "Read a file from the agent workspace.",
    safe: true,
  },
  {
    name: "write",
    label: "Write file",
    group: "Workspace",
    description: "Create or overwrite a workspace file.",
    safe: true,
  },
  {
    name: "bash",
    label: "Shell / list files",
    group: "Workspace",
    description: "Run shell commands in the workspace (includes listing files).",
    safe: true,
  },
  {
    name: "conversations_search",
    label: "Search conversations",
    group: "Memory",
    description: "Search this agent's own thread history.",
    safe: true,
  },
  {
    name: "conversations_list",
    label: "List conversations",
    group: "Memory",
    description: "List this agent's own threads with type and archive filters, sorted and paginated.",
    safe: true,
  },
  {
    name: "send_message",
    label: "Send message",
    group: "Messaging",
    description: "Open a new thread with a message to the user.",
    safe: true,
  },
  {
    name: "schedule_reminder",
    label: "Schedule reminder",
    group: "Routines",
    description: "Schedule a one-shot reminder for this agent.",
    safe: true,
  },
  {
    name: "list_routines",
    label: "List routines",
    group: "Routines",
    description: "List this agent's routines and their schedules.",
    safe: true,
  },
  {
    name: "create_routine",
    label: "Create routine",
    group: "Routines",
    description: "Create a recurring routine from a cron or interval schedule.",
    safe: true,
  },
  {
    name: "update_routine",
    label: "Update routine",
    group: "Routines",
    description: "Change a routine's schedule, prompt or enabled state.",
    safe: true,
  },
  {
    name: "delete_routine",
    label: "Delete routine",
    group: "Routines",
    description: "Delete a routine and stop its schedule.",
    safe: true,
  },
];

/** Baseline names, for the creation form's preselection. */
export const SAFE_BASELINE_NAMES = SAFE_BASELINE_TOOLS.map((t) => t.name);

/** Group tools for the creation/settings checklists, stable by group order
 *  of first appearance. */
export function groupTools(
  tools: AgentToolInfo[],
): { group: string; tools: AgentToolInfo[] }[] {
  const groups: { group: string; tools: AgentToolInfo[] }[] = [];
  for (const tool of tools) {
    const found = groups.find((g) => g.group === tool.group);
    if (found) found.tools.push(tool);
    else groups.push({ group: tool.group, tools: [tool] });
  }
  return groups;
}

// Activity over ClickHouse: traces (agent runs), spans (LLM and tool
// calls), sessions (chats) and the summary. One shape for the whole
// observability surface; the server owns the wire truth.

export interface TraceRow {
  trace_id: string;
  org_id: string;
  user_id: string | null;
  agent_id: string | null;
  agent_name: string;
  session_id: string | null;
  thread_id: string | null;
  parent_trace_id: string | null;
  routine_id: string | null;
  trigger: string;
  status: string;
  name: string;
  summary: string;
  error: string;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number;
  span_count: number;
  call_count: number;
  tool_count: number;
  error_count: number;
  tokens_in: number;
  tokens_out: number;
  reasoning_tokens: number;
  cost_usd: number;
  longest_ms: number;
}

export interface SpanRow {
  span_id: string;
  trace_id: string;
  run_id: string | null;
  parent_span_id: string | null;
  name: string;
  span_type: "llm" | "tool" | "run";
  status: "ok" | "error" | "running";
  start_time: string;
  end_time: string | null;
  duration_ms: number;
  model: string;
  provider: string;
  tokens_in: number;
  tokens_out: number;
  reasoning_tokens: number;
  cost_usd: number;
  error: string;
  input: string;
  output: string;
  request_id: string | null;
  caller: string;
  session_id: string | null;
  chat_id: string | null;
  attributes: Record<string, unknown>;
}

export interface ChatActivityRow {
  session_id: string;
  traces: number;
  calls: number;
  tool_calls: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  errors: number;
  started_at: string | null;
  ended_at: string | null;
  duration_ms: number;
}

export interface ActivityTotals {
  traces: number;
  failed_traces: number;
  calls: number;
  tool_calls: number;
  errors: number;
  tokens_in: number;
  tokens_out: number;
  reasoning_tokens: number;
  cost_usd: number;
  p50_ms: number;
  p95_ms: number;
}

export interface ActivitySummary {
  totals: ActivityTotals;
  by_day: {
    day: string;
    calls: number;
    tokens_in: number;
    tokens_out: number;
    cost_usd: number;
    p95_ms: number;
  }[];
}

export interface ActivityQuery {
  from?: string;
  to?: string;
  agent?: string;
  status?: string;
  trigger?: string;
  q?: string;
  type?: "llm" | "tool";
  caller?: "model" | "judge";
  model?: string;
  session?: string;
  trace?: string;
  limit?: number;
  offset?: number;
}

function activityQuery(filters: ActivityQuery): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === "" || value === "all") continue;
    query.set(key, String(value));
  }
  return query.toString() ? `?${query}` : "";
}

export async function listTraces(
  filters: ActivityQuery = {},
): Promise<{ traces: TraceRow[]; total: number }> {
  return request<{ traces: TraceRow[]; total: number }>("GET", `/api/v1/activity/traces${activityQuery(filters)}`);
}

export async function getTrace(traceId: string): Promise<{
  trace: TraceRow;
  spans: SpanRow[];
  children: TraceRow[];
}> {
  return request<{ trace: TraceRow; spans: SpanRow[]; children: TraceRow[] }>("GET", `/api/v1/activity/traces/${encodeURIComponent(traceId)}`);
}

export async function listSpans(
  filters: ActivityQuery = {},
): Promise<{ spans: SpanRow[]; total: number }> {
  return request<{ spans: SpanRow[]; total: number }>("GET", `/api/v1/activity/spans${activityQuery(filters)}`);
}

export async function listChatActivity(
  filters: ActivityQuery = {},
): Promise<{ chats: ChatActivityRow[]; total: number }> {
  const body = await request<{ sessions: ChatActivityRow[]; total: number }>("GET", `/api/v1/activity/sessions${activityQuery(filters)}`);
  return { chats: body.sessions, total: body.total };
}

export async function getActivitySummary(
  filters: ActivityQuery = {},
): Promise<ActivitySummary> {
  return request<ActivitySummary>("GET", `/api/v1/activity/summary${activityQuery(filters)}`);
}

export async function getSpanPayloads(
  spanId: string,
): Promise<{ kind: string; body: string }[]> {
  const body = await request<{ payloads: { kind: string; body: string }[] }>("GET", `/api/v1/activity/spans/${encodeURIComponent(spanId)}/payloads`);
  return body.payloads;
}
