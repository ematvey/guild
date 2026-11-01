// Agent state shared by every view: the agent list, and per agent its runs,
// the member's threads and its routines. Every slice is live through
// member-socket frames (`agent_list`, `agent_run`, `agent_threads`,
// `agent_routines`). A per-agent slice is seeded over HTTP only for the first
// paint of a connection: the server pushes it when it changes, not on
// connect, so a reconnect drops the per-agent slices and the views on screen
// seed them again. A frame that lands before its seed wins over the seed.

import { useEffect, useSyncExternalStore } from "react";
import type { Agent, AgentRoutine, AgentRun, AgentThread, TraceRow } from "./agents-api";
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
 *  run carries the status, summary, end and error the row shows. The span
 *  totals stay as the trace store reported them. */
export function traceWithRun(trace: TraceRow, run: AgentRun): TraceRow {
  return {
    ...trace,
    status: run.status,
    summary: run.summary ?? trace.summary,
    error: run.error_message ?? trace.error,
    started_at: run.started_at ?? trace.started_at,
    finished_at: run.finished_at ?? null,
  };
}

/** A new run as an activity trace row, before the trace store has its spans. */
export function traceFromRun(run: AgentRun): TraceRow {
  return {
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
