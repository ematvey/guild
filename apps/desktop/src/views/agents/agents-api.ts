// Client for the persistent-agents API (docs/specs/2026-10-18-persistent-
// agents.md, "API surface"). Shapes mirror the design's data model; the
// server owns the wire truth, so list responses accept both a bare array
// and a keyed envelope.

import { apiUrl, getToken } from "../../transport";
import type {
  AgentStatus,
  AgentVisibility,
  InboxKind,
  RunStatus,
  RunTrigger,
} from "./agents-route";

export class AgentsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AgentsApiError";
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${getToken()}`);
  if (init.body !== undefined && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  const res = await fetch(apiUrl(path), { ...init, headers });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as {
        error?: { message?: string } | string;
        message?: string;
      };
      if (typeof body.error === "string") message = body.error;
      else if (body.error?.message) message = body.error.message;
      else if (body.message) message = body.message;
    } catch {
      // Non-JSON error body: keep the status text.
    }
    throw new AgentsApiError(message || `Request failed (${res.status})`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Authed binary/blob request (file preview and download). */
export async function agentFileResponse(path: string): Promise<Response> {
  const res = await fetch(apiUrl(path), {
    headers: { authorization: `Bearer ${getToken()}` },
  });
  if (!res.ok) throw new AgentsApiError(res.statusText, res.status);
  return res;
}

function oneOf<T>(value: unknown, key: string): T {
  if (value && typeof value === "object" && key in value) {
    return (value as Record<string, T>)[key]!;
  }
  return value as T;
}

function listOf<T>(value: unknown, ...keys: string[]): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value && typeof value === "object") {
    for (const key of keys) {
      const found = (value as Record<string, unknown>)[key];
      if (Array.isArray(found)) return found as T[];
    }
  }
  return [];
}

/** The identity line from the agent's workspace IDENTITY.md. */
export interface AgentIdentity {
  name: string | null;
  vibe: string | null;
  emoji: string | null;
  avatar: string | null;
}

export interface Agent {
  id: string;
  org_id: string;
  owner_user_id: string;
  owner_label?: string | null;
  owner_email?: string | null;
  owner_avatar_url?: string | null;
  name: string;
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
  /** Parsed IDENTITY.md; null fields when the file is absent or blank. */
  identity?: AgentIdentity | null;
}

export interface AgentThread {
  id: string;
  agent_id: string;
  /** The durable chat journal this thread projects into. Agent threads are
   *  chats; the transcript and send pipeline use this id. */
  chat_id: string;
  title: string;
  title_locked: boolean;
  kind: "default" | "thread" | "routine_run";
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

export interface AgentNotice {
  id: string;
  org_id: string;
  agent_id?: string | null;
  agent_name?: string | null;
  user_id?: string | null;
  kind: InboxKind;
  payload: Record<string, unknown>;
  read_at?: string | null;
  created_at: string;
  thread_id?: string | null;
  run_id?: string | null;
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

export interface AgentToolInfo {
  name: string;
  label: string;
  group: string;
  description: string;
  safe: boolean;
}

export interface CreateAgentInput {
  name: string;
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
  return listOf<Agent>(await request<unknown>(`/api/v1/agents${query}`), "agents");
}

export async function getAgent(id: string): Promise<Agent> {
  return oneOf<Agent>(await request<unknown>(agentBase(id)), "agent");
}

export interface TeamOption {
  id: string;
  name: string;
}

export async function listMyTeams(): Promise<TeamOption[]> {
  const body = await request<{ teams: TeamOption[] }>("/api/v1/skills/teams");
  return body.teams;
}

export async function createAgent(input: CreateAgentInput): Promise<Agent> {
  return oneOf<Agent>(
    await request<unknown>("/api/v1/agents", {
      method: "POST",
      body: JSON.stringify(input),
    }),
    "agent",
  );
}

export async function updateAgent(
  id: string,
  input: UpdateAgentInput,
): Promise<Agent> {
  return oneOf<Agent>(
    await request<unknown>(agentBase(id), {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
    "agent",
  );
}

export async function archiveAgent(id: string): Promise<Agent> {
  return oneOf<Agent>(
    await request<unknown>(`${agentBase(id)}/archive`, { method: "POST" }),
    "agent",
  );
}

export async function restoreAgent(id: string): Promise<Agent> {
  return oneOf<Agent>(
    await request<unknown>(`${agentBase(id)}/restore`, { method: "POST" }),
    "agent",
  );
}

export async function exportAgent(id: string): Promise<unknown> {
  const body = await request<{ export: unknown }>(`${agentBase(id)}/export`);
  return body.export;
}

export async function purgeAgent(id: string, force = false): Promise<void> {
  await request<{ purged: boolean }>(`${agentBase(id)}/purge${force ? "?force=1" : ""}`, {
    method: "POST",
  });
}

export async function deleteAgent(id: string): Promise<void> {
  await request<void>(agentBase(id), { method: "DELETE" });
}

export async function listAgentThreads(id: string): Promise<AgentThread[]> {
  return listOf<AgentThread>(
    await request<unknown>(`${agentBase(id)}/threads`),
    "threads",
  );
}

export async function getAgentThread(
  id: string,
  threadId: string,
): Promise<AgentThread> {
  return oneOf<AgentThread>(
    await request<unknown>(
      `${agentBase(id)}/threads/${encodeURIComponent(threadId)}`,
    ),
    "thread",
  );
}

export async function renameAgentThread(
  id: string,
  threadId: string,
  title: string,
): Promise<AgentThread> {
  return oneOf<AgentThread>(
    await request<unknown>(`${agentBase(id)}/threads/${encodeURIComponent(threadId)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
    "thread",
  );
}

export type ChildThreadAction = "cancel" | "close";

export type ChildThreadActionResult =
  | { ok: true }
  | { ok: false; unavailable: true }
  | { ok: false; unavailable: false; error: string };

/** Cancel or close a child thread. The server endpoints are not built yet
 *  (WP3): a 404/501 means "not available yet", not a failed request. */
export async function childThreadAction(
  chatId: string,
  action: ChildThreadAction,
): Promise<ChildThreadActionResult> {
  try {
    await request<void>(
      `/api/v1/threads/${encodeURIComponent(chatId)}/${action}`,
      { method: "POST" },
    );
    return { ok: true };
  } catch (error) {
    if (error instanceof AgentsApiError && (error.status === 404 || error.status === 501)) {
      return { ok: false, unavailable: true };
    }
    return {
      ok: false,
      unavailable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function createAgentThread(
  id: string,
  title?: string,
): Promise<AgentThread> {
  return oneOf<AgentThread>(
    await request<unknown>(`${agentBase(id)}/threads`, {
      method: "POST",
      body: JSON.stringify(title ? { title } : {}),
    }),
    "thread",
  );
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
  const res = await fetch(apiUrl(`${agentBase(id)}/turns`), {
    method: "POST",
    headers: {
      authorization: `Bearer ${getToken()}`,
      "content-type": "application/json",
      accept: "text/event-stream, application/json",
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      message = body.error?.message ?? message;
    } catch {
      // Keep the status text.
    }
    throw new AgentsApiError(message, res.status);
  }
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
  return listOf<AgentRun>(
    await request<unknown>(`${agentBase(id)}/runs`),
    "runs",
  );
}

export async function getRun(runId: string): Promise<AgentRun> {
  return oneOf<AgentRun>(
    await request<unknown>(`/api/v1/runs/${encodeURIComponent(runId)}`),
    "run",
  );
}

export async function listRunChildren(runId: string): Promise<AgentRun[]> {
  const body = await request<{ children: AgentRun[] }>(
    `/api/v1/runs/${encodeURIComponent(runId)}/children`,
  );
  return body.children;
}

export interface AgentArtifact {
  id: string;
  path: string;
  size: number;
  status: "inbox" | "staged" | "released";
  inbox_path?: string | null;
  staging_path?: string | null;
  created_at: string;
}

export async function listRunArtifacts(runId: string): Promise<AgentArtifact[]> {
  const body = await request<{ artifacts: AgentArtifact[] }>(
    `/api/v1/runs/${encodeURIComponent(runId)}/artifacts`,
  );
  return body.artifacts;
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
  return listOf<AgentRun>(
    await request<unknown>(`/api/v1/activity${suffix}`),
    "runs",
    "activity",
  );
}

export async function listRoutines(id: string): Promise<AgentRoutine[]> {
  return listOf<AgentRoutine>(
    await request<unknown>(`${agentBase(id)}/routines`),
    "routines",
  );
}

export async function getRoutine(
  id: string,
  routineId: string,
): Promise<AgentRoutine> {
  return oneOf<AgentRoutine>(
    await request<unknown>(
      `${agentBase(id)}/routines/${encodeURIComponent(routineId)}`,
    ),
    "routine",
  );
}

export async function createRoutine(
  id: string,
  input: RoutineInput,
): Promise<AgentRoutine> {
  return oneOf<AgentRoutine>(
    await request<unknown>(`${agentBase(id)}/routines`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
    "routine",
  );
}

export async function updateRoutine(
  id: string,
  routineId: string,
  input: Partial<RoutineInput>,
): Promise<AgentRoutine> {
  return oneOf<AgentRoutine>(
    await request<unknown>(
      `${agentBase(id)}/routines/${encodeURIComponent(routineId)}`,
      { method: "PATCH", body: JSON.stringify(input) },
    ),
    "routine",
  );
}

export async function deleteRoutine(
  id: string,
  routineId: string,
): Promise<void> {
  await request<void>(
    `${agentBase(id)}/routines/${encodeURIComponent(routineId)}`,
    { method: "DELETE" },
  );
}

export async function runRoutine(
  id: string,
  routineId: string,
): Promise<AgentRun | null> {
  const value = await request<unknown>(
    `${agentBase(id)}/routines/${encodeURIComponent(routineId)}/run`,
    { method: "POST" },
  );
  if (value === null || value === undefined) return null;
  return oneOf<AgentRun>(value, "run");
}

export async function listRoutineRuns(
  id: string,
  routineId: string,
): Promise<AgentRun[]> {
  return listOf<AgentRun>(
    await request<unknown>(
      `${agentBase(id)}/routines/${encodeURIComponent(routineId)}/runs`,
    ),
    "runs",
  );
}

export async function listInbox(): Promise<AgentNotice[]> {
  return listOf<AgentNotice>(await request<unknown>("/api/v1/inbox"), "items", "notices");
}

export async function markInboxRead(
  noticeId: string,
  read = true,
): Promise<void> {
  await request<void>(
    `/api/v1/inbox/${encodeURIComponent(noticeId)}/${read ? "read" : "unread"}`,
    { method: "POST" },
  );
}

export async function listAgentFiles(
  id: string,
  path: string,
  hidden = false,
): Promise<AgentFileEntry[]> {
  const query = new URLSearchParams({ path });
  if (hidden) query.set("hidden", "1");
  return listOf<AgentFileEntry>(
    await request<unknown>(`${agentBase(id)}/files?${query}`),
    "entries",
    "files",
  );
}

export async function getAgentFileContent(
  id: string,
  path: string,
): Promise<AgentFileContent> {
  const query = new URLSearchParams({ path });
  return request<AgentFileContent>(`${agentBase(id)}/files/content?${query}`);
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
  return listOf<AgentToolInfo>(
    await request<unknown>("/api/v1/agents/tools"),
    "tools",
  );
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

export type ActivityTab = "traces" | "calls" | "sessions";
export type ActivityPeriod = "24h" | "7d" | "30d";

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

export interface SessionRow {
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
  return request<{ traces: TraceRow[]; total: number }>(
    `/api/v1/activity/traces${activityQuery(filters)}`,
  );
}

export async function getTrace(traceId: string): Promise<{
  trace: TraceRow;
  spans: SpanRow[];
  children: TraceRow[];
}> {
  return request<{ trace: TraceRow; spans: SpanRow[]; children: TraceRow[] }>(
    `/api/v1/activity/traces/${encodeURIComponent(traceId)}`,
  );
}

export async function listSpans(
  filters: ActivityQuery = {},
): Promise<{ spans: SpanRow[]; total: number }> {
  return request<{ spans: SpanRow[]; total: number }>(
    `/api/v1/activity/spans${activityQuery(filters)}`,
  );
}

export async function listSessions(
  filters: ActivityQuery = {},
): Promise<{ sessions: SessionRow[]; total: number }> {
  return request<{ sessions: SessionRow[]; total: number }>(
    `/api/v1/activity/sessions${activityQuery(filters)}`,
  );
}

export async function getActivitySummary(
  filters: ActivityQuery = {},
): Promise<ActivitySummary> {
  return request<ActivitySummary>(
    `/api/v1/activity/summary${activityQuery(filters)}`,
  );
}

export async function getSpanPayloads(
  spanId: string,
): Promise<{ kind: string; body: string }[]> {
  const body = await request<{ payloads: { kind: string; body: string }[] }>(
    `/api/v1/activity/spans/${encodeURIComponent(spanId)}/payloads`,
  );
  return body.payloads;
}
