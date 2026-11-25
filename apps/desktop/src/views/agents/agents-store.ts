// Agent state shared by every view: the agent list, the Integrations the
// member may attach, and per agent its runs, the member's threads and its
// routines. Every slice is live through member-socket frames (`agent_list`,
// `integration_access`, `agent_run`, `agent_threads`, `agent_routines`). A per-agent slice is seeded over HTTP only for the first
// paint of a connection: the server pushes it when it changes, not on
// connect, so a reconnect drops the per-agent slices and the views on screen
// seed them again. A frame that lands before its seed wins over the seed: a
// pushed list replaces the slice, and a pushed run is held until the seed
// lands and merged over it.

import { useEffect } from "react";
import type { ActivitySummary, Agent, AgentRoutine, AgentRun, AgentThread, TraceRow } from "./agents-api";
import type { AttachableIntegration, CoordinationSnapshot } from "@guild/wire/rest";
import type { ServerFrame } from "@guild/wire/types";
import { listAgentRuns, listAgentThreads, listRoutines } from "./agents-api";
import { registerSessionReset } from "../../lib/session-reset";
import { createStore } from "../../lib/store";

type Slice = "runs" | "threads" | "routines";

interface AgentState {
  /** Every agent the member may see; null until the first push. */
  agents: Agent[] | null;
  /** The Integrations the member may attach; null until the first push. */
  attachable: AttachableIntegration[] | null;
  /** Per agent, newest first. */
  runs: Record<string, AgentRun[]>;
  threads: Record<string, AgentThread[]>;
  routines: Record<string, AgentRoutine[]>;
  coordination: Record<string, CoordinationSnapshot>;
  /** Why a slice's seed failed, by `slice:agentId`. */
  errors: Record<string, string>;
  /** Bumps on every reconnect and sign-out: the seeding hooks run again,
   *  and a seed started under an older epoch is dropped. */
  epoch: number;
}

const EMPTY: AgentState = {
  agents: null,
  attachable: null,
  runs: {},
  threads: {},
  routines: {},
  coordination: {},
  errors: {},
  epoch: 0,
};

const agentStore = createStore<AgentState>(EMPTY);
/** Never reset: a seed in flight across a reset must see the epoch move. */
let epochCounter = 0;
/** Runs pushed for an agent whose run seed is in flight, merged by the seed. */
const pendingRuns = new Map<string, AgentRun[]>();
/** `slice:agentId` of every seed in flight. */
const seeding = new Set<string>();
const runListeners = new Set<(run: AgentRun) => void>();
type ActivityRunFrame = Extract<ServerFrame, { type: "activity_run" | "activity_run_unavailable" }>;
const activityRunListeners = new Set<(frame: ActivityRunFrame, epoch: number) => void>();

export function applyActivityRun(frame: ActivityRunFrame): void {
  const epoch = agentStore.get().epoch;
  for (const listener of activityRunListeners) listener(frame, epoch);
}

export function useActivityRunUpdates(listener: (frame: ActivityRunFrame, epoch: number) => void): void {
  useEffect(() => {
    activityRunListeners.add(listener);
    return () => {
      activityRunListeners.delete(listener);
    };
  });
}

type ActivityConversationFrame = Extract<ServerFrame, { type: "activity_conversation" }>;
const conversationListeners = new Set<(frame: ActivityConversationFrame) => void>();

export function applyActivityConversation(frame: ActivityConversationFrame): void {
  for (const listener of conversationListeners) listener(frame);
}

export function useActivityConversationUpdates(listener: (frame: ActivityConversationFrame) => void): void {
  useEffect(() => {
    conversationListeners.add(listener);
    return () => {
      conversationListeners.delete(listener);
    };
  });
}

const sliceKey = (slice: Slice, agentId: string) => `${slice}:${agentId}`;

/** Newest first: the order every run list shows. */
function byCreatedDesc(a: { created_at: string }, b: { created_at: string }): number {
  return Date.parse(b.created_at) - Date.parse(a.created_at);
}

/** Puts one run into a list by id: a changed run replaces its row, a new one
 *  joins in creation order. */
export function upsertRun<T extends { id: string; created_at: string }>(rows: T[], run: T): T[] {
  const index = rows.findIndex((row) => row.id === run.id);
  if (index >= 0) return rows.map((row, i) => (i === index ? { ...row, ...run } : row));
  return [...rows, run].sort(byCreatedDesc);
}

/** Replaces the agent list (the `agent_list` frame). */
export function applyAgentList(agents: Agent[]): void {
  const visible = new Set(agents.map((agent) => agent.id));
  agentStore.update((state) => ({
    ...state, agents, coordination: Object.fromEntries(
      Object.entries(state.coordination).filter(([id]) => visible.has(id)),
    ),
  }));
}

/** Replaces the attachable Integrations (the `integration_access` frame). */
export function applyIntegrationAccess(attachable: AttachableIntegration[]): void {
  agentStore.update((state) => ({ ...state, attachable }));
}

/** Applies one run (the `agent_run` frame): its agent's loaded run list moves,
 *  and every view that keeps its own run rows hears it. A run for an agent
 *  whose seed is still in flight waits for that seed. */
export function applyAgentRun(run: AgentRun): void {
  const rows = agentStore.get().runs[run.agent_id];
  if (rows !== undefined) {
    agentStore.update((state) => ({ ...state, runs: { ...state.runs, [run.agent_id]: upsertRun(rows, run) } }));
  } else if (seeding.has(sliceKey("runs", run.agent_id))) {
    pendingRuns.set(run.agent_id, upsertRun(pendingRuns.get(run.agent_id) ?? [], run));
  }
  for (const listener of runListeners) listener(run);
}

export function applyAgentCoordination(frame: Extract<ServerFrame, { type: "agent_coordination" }>): void {
  agentStore.update((state) => ({
    ...state, coordination: { ...state.coordination, [frame.agent_id]: frame.snapshot },
  }));
}

export function scrubAgentCoordination(): void {
  agentStore.update((state) => ({
    ...state, coordination: Object.fromEntries(Object.entries(state.coordination).map(([agentId, snapshot]) =>
      [agentId, { ...snapshot, outcomes: snapshot.outcomes.filter((outcome) => outcome.owned) }],
    )),
  }));
}

export function useAgentCoordination(agentId: string): CoordinationSnapshot | undefined {
  return agentStore.use((state) => state.coordination[agentId]);
}

/** Replaces one agent's thread list (the `agent_threads` frame). */
export function applyAgentThreads(agentId: string, threads: AgentThread[]): void {
  agentStore.update((state) => ({ ...state, threads: { ...state.threads, [agentId]: threads } }));
}

/** Replaces one agent's routines (the `agent_routines` frame). */
export function applyAgentRoutines(agentId: string, routines: AgentRoutine[]): void {
  agentStore.update((state) => ({ ...state, routines: { ...state.routines, [agentId]: routines } }));
}

function dropSeeds(): void {
  pendingRuns.clear();
  seeding.clear();
}

/** A new connection: the per-agent slices may have missed changes while the
 *  socket was down, so they seed again. The agent list stays until the
 *  connect push replaces it. */
export function resetAgentSlices(): void {
  dropSeeds();
  agentStore.update((state) => ({ ...state, runs: {}, threads: {}, routines: {}, coordination: {}, errors: {}, epoch: ++epochCounter }));
}

/** Drops everything; sign-out runs it so one user's agents never reach
 *  the next session. */
export function clearAgentState(): void {
  dropSeeds();
  agentStore.set({ ...EMPTY, epoch: ++epochCounter });
}
registerSessionReset(clearAgentState);

/** Seeds one per-agent slice from its HTTP read, unless a frame got there
 *  first. Runs merge: a pushed row is newer than the read. */
function seed(slice: Slice, agentId: string, rows: AgentRun[] | AgentThread[] | AgentRoutine[]): void {
  agentStore.update((state) => {
    if (slice === "runs") {
      const pushed = [...(state.runs[agentId] ?? []), ...(pendingRuns.get(agentId) ?? [])];
      pendingRuns.delete(agentId);
      const read = [...(rows as AgentRun[])].sort(byCreatedDesc);
      return { ...state, runs: { ...state.runs, [agentId]: pushed.reduce((all, run) => upsertRun(all, run), read) } };
    }
    if (state[slice][agentId] !== undefined) return state;
    return { ...state, [slice]: { ...state[slice], [agentId]: rows } };
  });
}

function failSeed(slice: Slice, agentId: string, err: unknown): void {
  if (slice === "runs") pendingRuns.delete(agentId);
  const message = err instanceof Error && err.message ? err.message : "Could not load this list.";
  agentStore.update((state) => ({ ...state, errors: { ...state.errors, [sliceKey(slice, agentId)]: message } }));
}

function clearSeedError(slice: Slice, agentId: string): void {
  const key = sliceKey(slice, agentId);
  agentStore.update((state) => {
    if (!(key in state.errors)) return state;
    const errors = { ...state.errors };
    delete errors[key];
    return { ...state, errors };
  });
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
  // A finished run's frame counts its calls; a count never moves backwards.
  if (typeof run.call_count === "number" && run.call_count > trace.call_count) next.call_count = run.call_count;
  if (typeof run.tool_count === "number" && run.tool_count > trace.tool_count) next.tool_count = run.tool_count;
  return next;
}

/** The activity summary moved by one trace row's change: `before` is the
 *  row as it was (undefined for a run new to the window). A new row counts
 *  as a trace, a move into "failed" as a failed trace, and token and call
 *  growth adds to the totals. */
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
  totals.tool_calls += after.tool_count - (before?.tool_count ?? 0);
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
    session_id: null,
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
 *  such as a Routine's run history) patch from it. */
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
  return agentStore.use((state) => state.agents);
}

/** The Integrations the member may add to an agent; null until the first
 *  push. */
export function useAttachableIntegrations(): AttachableIntegration[] | null {
  return agentStore.use((state) => state.attachable);
}

/** The native member socket's generation, for views that seed live slices. */
export function useAgentConnectionEpoch(): number {
  return agentStore.use((state) => state.epoch);
}

/** A seeded per-agent slice: `rows` is null until it seeds; `error` says why
 *  the seed failed (rows stay null), and `retry` seeds again. */
export interface SeededSlice<T> {
  rows: T[] | null;
  error: string | null;
  retry: () => void;
}

function useSeededSlice<T>(slice: Slice, agentId: string, load: (id: string) => Promise<T[]>): SeededSlice<T> {
  const rows = agentStore.use((state) => (state[slice][agentId] as T[] | undefined) ?? null);
  const error = agentStore.use((state) => state.errors[sliceKey(slice, agentId)] ?? null);
  const epoch = agentStore.use((state) => state.epoch);
  const needed = rows === null && error === null;
  useEffect(() => {
    if (!needed) return;
    const key = sliceKey(slice, agentId);
    let live = true;
    seeding.add(key);
    const current = () => live && agentStore.get().epoch === epoch;
    load(agentId)
      .then(
        (loaded) => {
          if (current()) seed(slice, agentId, loaded as AgentRun[]);
        },
        (err: unknown) => {
          if (current()) failSeed(slice, agentId, err);
        },
      )
      .finally(() => {
        if (agentStore.get().epoch === epoch) seeding.delete(key);
      });
    return () => {
      live = false;
    };
  }, [slice, agentId, epoch, needed, load]);
  return { rows, error, retry: () => clearSeedError(slice, agentId) };
}

/** One agent's runs, newest first; rows null until seeded. */
export function useAgentRuns(agentId: string): SeededSlice<AgentRun> {
  return useSeededSlice("runs", agentId, listAgentRuns);
}

/** The member's open threads with one agent; rows null until seeded. */
export function useAgentThreads(agentId: string): SeededSlice<AgentThread> {
  return useSeededSlice("threads", agentId, listAgentThreads);
}

/** One agent's routines with their newest runs; rows null until seeded. */
export function useAgentRoutines(agentId: string): SeededSlice<AgentRoutine> {
  return useSeededSlice("routines", agentId, listRoutines);
}
