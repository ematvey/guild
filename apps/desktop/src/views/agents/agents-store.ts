// Agent state shared by every view: the agent list, and per agent its runs,
// the member's threads and its routines. Every slice is live through
// member-socket frames (`agent_list`, `agent_run`, `agent_threads`,
// `agent_routines`). A per-agent slice is seeded over HTTP only for the first
// paint of a connection: the server pushes it when it changes, not on
// connect, so a reconnect drops the per-agent slices and the views on screen
// seed them again. A frame that lands before its seed wins over the seed.

import { useEffect, useSyncExternalStore } from "react";
import type { ActivitySummary, Agent, AgentRoutine, AgentRun, AgentThread, TraceRow } from "./agents-api";
import { listAgentRuns, listAgentThreads, listRoutines } from "./agents-api";

type Slice = "runs" | "threads" | "routines";

interface AgentState {
  /** Every agent the member may see; null until the first push. */
  agents: Agent[] | null;
  /** Per agent, newest first. */
  runs: Record<string, AgentRun[]>;
  threads: Record<string, AgentThread[]>;
  routines: Record<string, AgentRoutine[]>;
  /** Bumps on every reconnect: the seeding hooks run again. */
  epoch: number;
}

const EMPTY: AgentState = { agents: null, runs: {}, threads: {}, routines: {}, epoch: 0 };

let state: AgentState = EMPTY;
const listeners = new Set<() => void>();
const runListeners = new Set<(run: AgentRun) => void>();

function emit(next: AgentState): void {
  state = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Newest first: the order every run list shows. */
function byCreatedDesc(a: AgentRun, b: AgentRun): number {
  return Date.parse(b.created_at) - Date.parse(a.created_at);
}

/** Puts one run into a list by id: a changed run replaces its row, a new one
 *  joins in creation order. */
export function upsertRun<T extends { id: string; created_at: string }>(rows: T[], run: T): T[] {
  const index = rows.findIndex((row) => row.id === run.id);
  if (index >= 0) return rows.map((row, i) => (i === index ? { ...row, ...run } : row));
  return [...rows, run].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
}

/** Replaces the agent list (the `agent_list` frame). */
export function applyAgentList(agents: Agent[]): void {
  emit({ ...state, agents });
}

/** Applies one run (the `agent_run` frame): its agent's loaded run list moves,
 *  and every view that keeps its own run rows hears it. */
export function applyAgentRun(run: AgentRun): void {
  const rows = state.runs[run.agent_id];
  if (rows !== undefined) emit({ ...state, runs: { ...state.runs, [run.agent_id]: upsertRun(rows, run) } });
  for (const listener of runListeners) listener(run);
}

/** Replaces one agent's thread list (the `agent_threads` frame). */
export function applyAgentThreads(agentId: string, threads: AgentThread[]): void {
  emit({ ...state, threads: { ...state.threads, [agentId]: threads } });
}

/** Replaces one agent's routines (the `agent_routines` frame). */
export function applyAgentRoutines(agentId: string, routines: AgentRoutine[]): void {
  emit({ ...state, routines: { ...state.routines, [agentId]: routines } });
}

/** A new connection: the per-agent slices may have missed changes while the
 *  socket was down, so they seed again. The agent list stays until the
 *  connect push replaces it. */
export function resetAgentSlices(): void {
  emit({ ...state, runs: {}, threads: {}, routines: {}, epoch: state.epoch + 1 });
}

/** Drops everything; sign-out calls this so one user's agents never reach
 *  the next session. */
export function clearAgentState(): void {
  emit({ ...EMPTY, epoch: state.epoch + 1 });
}

/** Seeds one per-agent slice from its HTTP read, unless a frame got there
 *  first. Runs merge: a pushed row is newer than the read. */
function seed(slice: Slice, agentId: string, rows: AgentRun[] | AgentThread[] | AgentRoutine[]): void {
  const current = state[slice][agentId];
  if (slice === "runs") {
    const pushed = (current ?? []) as AgentRun[];
    const merged = (rows as AgentRun[]).filter((row) => !pushed.some((p) => p.id === row.id));
    emit({ ...state, runs: { ...state.runs, [agentId]: [...pushed, ...merged].sort(byCreatedDesc) } });
    return;
  }
  if (current !== undefined) return;
  emit({ ...state, [slice]: { ...state[slice], [agentId]: rows } });
}

/** A trace row moved by its run's frame: the trace id is the run id, and the
 *  run carries the status, summary, error, start, end and token total the
 *  row shows. The duration follows from the run's start and end. The run
 *  carries one token total, not the in/out split: a total above the row's
 *  sum counts its difference as input until the trace store's split
 *  arrives. Counts the run does not carry (calls, tools, spans) keep their
 *  last known value. */
export function traceWithRun(trace: TraceRow, run: AgentRun): TraceRow {
  const startedAt = run.started_at ?? trace.started_at;
  const finishedAt = run.finished_at ?? null;
  const next: TraceRow = {
    ...trace,
    status: run.status,
    summary: run.summary ?? trace.summary,
    error: run.error_message ?? trace.error,
    started_at: startedAt,
    finished_at: finishedAt,
  };
  if (startedAt !== null && finishedAt !== null) {
    const duration = Date.parse(finishedAt) - Date.parse(startedAt);
    if (Number.isFinite(duration) && duration >= 0) next.duration_ms = duration;
  }
  const known = trace.tokens_in + trace.tokens_out;
  if (typeof run.tokens === "number" && run.tokens > known) next.tokens_in = trace.tokens_in + (run.tokens - known);
  return next;
}

/** The activity summary moved by one trace row's change: `before` is the
 *  row as it was (undefined for a run new to the window). A new row counts
 *  as a trace, a move into "failed" as a failed trace, and token growth adds
 *  to the totals. */
export function summaryWithTrace(
  summary: ActivitySummary,
  before: TraceRow | undefined,
  after: TraceRow,
): ActivitySummary {
  const totals = { ...summary.totals };
  if (before === undefined) totals.traces += 1;
  if (after.status === "failed" && before?.status !== "failed") totals.failed_traces += 1;
  totals.tokens_in += after.tokens_in - (before?.tokens_in ?? 0);
  totals.tokens_out += after.tokens_out - (before?.tokens_out ?? 0);
  totals.calls += after.call_count - (before?.call_count ?? 0);
  return { ...summary, totals };
}

const TERMINAL_STATUSES: ReadonlySet<string> = new Set(["succeeded", "failed", "silent", "skipped", "cancelled"]);

/** True when the pushed run reaches a terminal status the screen does not
 *  show yet: `shown` is the status on screen, null before the first read. */
export function runFinishes(shown: string | null, pushed: AgentRun): boolean {
  return shown !== null && !TERMINAL_STATUSES.has(shown) && TERMINAL_STATUSES.has(pushed.status);
}

/** A new run as an activity trace row, before the trace store has its spans. */
export function traceFromRun(run: AgentRun): TraceRow {
  const row: TraceRow = {
    trace_id: run.id,
    org_id: "",
    user_id: run.user_id ?? null,
    agent_id: run.agent_id,
    agent_name: run.agent_name ?? "",
    session_id: run.chat_id ?? null,
    thread_id: run.thread_id ?? null,
    parent_trace_id: run.parent_run_id ?? null,
    routine_id: run.routine_id ?? null,
    trigger: run.trigger,
    status: run.status,
    name: run.routine_name ?? run.agent_name ?? "",
    summary: run.summary ?? "",
    error: run.error_message ?? "",
    started_at: run.started_at ?? run.created_at,
    finished_at: run.finished_at ?? null,
    duration_ms: 0,
    span_count: 0,
    call_count: 0,
    tool_count: 0,
    error_count: 0,
    tokens_in: 0,
    tokens_out: 0,
    reasoning_tokens: 0,
    cost_usd: 0,
    longest_ms: 0,
  };
  return traceWithRun(row, run);
}

/** Subscribes to every run frame; views that keep their own run rows (the
 *  activity table, a trace page, a routine's run history) patch from it. */
export function onAgentRun(listener: (run: AgentRun) => void): () => void {
  runListeners.add(listener);
  return () => {
    runListeners.delete(listener);
  };
}

/** The same subscription as a hook. The listener may change every render. */
export function useAgentRunUpdates(listener: (run: AgentRun) => void): void {
  useEffect(() => onAgentRun(listener));
}

/** Every agent the member may see; null until the first push. */
export function useAgentList(): Agent[] | null {
  return useSyncExternalStore(subscribe, () => state.agents, () => state.agents);
}

function useSeededSlice<T>(slice: Slice, agentId: string, load: (id: string) => Promise<T[]>): T[] | null {
  const value = useSyncExternalStore(
    subscribe,
    () => (state[slice][agentId] as T[] | undefined) ?? null,
    () => (state[slice][agentId] as T[] | undefined) ?? null,
  );
  const epoch = useSyncExternalStore(subscribe, () => state.epoch, () => state.epoch);
  const needed = value === null;
  useEffect(() => {
    if (!needed) return;
    let live = true;
    void load(agentId)
      .catch(() => [] as T[])
      .then((rows) => {
        if (live) seed(slice, agentId, rows as AgentRun[]);
      });
    return () => {
      live = false;
    };
    // `load` is a module function; the slice re-seeds per agent and epoch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slice, agentId, epoch, needed]);
  return value;
}

/** One agent's runs, newest first; null until seeded. */
export function useAgentRuns(agentId: string): AgentRun[] | null {
  return useSeededSlice("runs", agentId, listAgentRuns);
}

/** The member's open threads with one agent; null until seeded. */
export function useAgentThreads(agentId: string): AgentThread[] | null {
  return useSeededSlice("threads", agentId, listAgentThreads);
}

/** One agent's routines with their newest runs; null until seeded. */
export function useAgentRoutines(agentId: string): AgentRoutine[] | null {
  return useSeededSlice("routines", agentId, listRoutines);
}
