// @vitest-environment happy-dom
// The agent store applies pushed frames: the list replaces, a run upserts
// into its agent's loaded list and reaches run listeners, a per-agent slice
// seeds over HTTP only until a frame owns it, and a reconnect re-seeds.
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ActivitySummary, Agent, AgentRun, AgentThread, TraceRow } from "./agents-api";
import { makeRun, makeThread } from "./test-fixtures";
import { resetSessionState } from "../../lib/session-reset";

const api = vi.hoisted(() => ({
  listAgentRuns: vi.fn(),
  listAgentThreads: vi.fn(),
  listRoutines: vi.fn(),
}));
vi.mock("./agents-api", () => api);

import {
  applyAgentList,
  applyAgentRun,
  applyAgentThreads,
  clearAgentState,
  onAgentRun,
  resetAgentSlices,
  summaryWithTrace,
  traceFromRun,
  traceWithRun,
  upsertRun,
  useAgentList,
  useAgentRuns,
  useAgentThreads,
} from "./agents-store";

function run(id: string, status: AgentRun["status"], created_at: string): AgentRun {
  return makeRun({ id, status, created_at });
}

function thread(id: string, title: string): AgentThread {
  return makeThread({ id, chat_id: `chat-${id}`, title });
}

afterEach(() => {
  cleanup();
  clearAgentState();
  vi.clearAllMocks();
});

describe("agents store", () => {
  it("replaces the agent list on every agent_list frame", () => {
    const { result } = renderHook(() => useAgentList());
    expect(result.current).toBeNull();
    act(() => applyAgentList([{ id: "a1", name: "one" } as Agent]));
    expect(result.current?.map((a) => a.name)).toEqual(["one"]);
    act(() => applyAgentList([{ id: "a1", name: "renamed" } as Agent]));
    expect(result.current?.map((a) => a.name)).toEqual(["renamed"]);
  });

  it("seeds runs once, then upserts pushed runs and tells run listeners", async () => {
    api.listAgentRuns.mockResolvedValue([run("r1", "succeeded", "2026-11-01T00:00:00Z")]);
    const heard: string[] = [];
    const off = onAgentRun((r) => heard.push(`${r.id}:${r.status}`));
    const { result } = renderHook(() => useAgentRuns("a1"));
    await waitFor(() => expect(result.current.rows).not.toBeNull());
    act(() => applyAgentRun(run("r2", "running", "2026-11-02T00:00:00Z")));
    expect(result.current.rows?.map((r) => `${r.id}:${r.status}`)).toEqual(["r2:running", "r1:succeeded"]);
    act(() => applyAgentRun(run("r2", "succeeded", "2026-11-02T00:00:00Z")));
    expect(result.current.rows?.map((r) => `${r.id}:${r.status}`)).toEqual(["r2:succeeded", "r1:succeeded"]);
    expect(heard).toEqual(["r2:running", "r2:succeeded"]);
    expect(api.listAgentRuns).toHaveBeenCalledTimes(1);
    off();
  });

  it("lets a thread frame win over a late seed and re-seeds after a reconnect", async () => {
    let resolveSeed: (rows: AgentThread[]) => void = () => {};
    api.listAgentThreads.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSeed = resolve;
      }),
    );
    const { result } = renderHook(() => useAgentThreads("a1"));
    act(() => applyAgentThreads("a1", [thread("t1", "pushed")]));
    await act(async () => {
      resolveSeed([thread("t1", "stale")]);
    });
    expect(result.current.rows?.map((t) => t.title)).toEqual(["pushed"]);

    api.listAgentThreads.mockResolvedValueOnce([thread("t1", "after reconnect")]);
    act(() => resetAgentSlices());
    await waitFor(() => expect(result.current.rows?.map((t) => t.title)).toEqual(["after reconnect"]));
  });

  it("keeps a run pushed before its agent's seed and merges it over the read", async () => {
    let resolveSeed: (rows: AgentRun[]) => void = () => {};
    api.listAgentRuns.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSeed = resolve;
      }),
    );
    const { result } = renderHook(() => useAgentRuns("a1"));
    act(() => applyAgentRun(run("r2", "succeeded", "2026-11-02T00:00:00Z")));
    expect(result.current.rows).toBeNull();
    await act(async () => {
      resolveSeed([run("r2", "running", "2026-11-02T00:00:00Z"), run("r1", "succeeded", "2026-11-01T00:00:00Z")]);
    });
    expect(result.current.rows?.map((r) => `${r.id}:${r.status}`)).toEqual(["r2:succeeded", "r1:succeeded"]);
  });

  it("reports a failed seed as an error, not an empty list, and retries", async () => {
    api.listAgentThreads.mockRejectedValueOnce(new Error("offline"));
    const { result } = renderHook(() => useAgentThreads("a1"));
    await waitFor(() => expect(result.current.error).toBe("offline"));
    expect(result.current.rows).toBeNull();
    api.listAgentThreads.mockResolvedValueOnce([thread("t1", "back")]);
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.rows?.map((t) => t.title)).toEqual(["back"]));
    expect(result.current.error).toBeNull();
  });

  it("drops a seed that lands after sign-out", async () => {
    let resolveSeed: (rows: AgentThread[]) => void = () => {};
    api.listAgentThreads.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSeed = resolve;
      }),
    );
    api.listAgentThreads.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useAgentThreads("a1"));
    act(() => resetSessionState());
    await act(async () => {
      resolveSeed([thread("t1", "previous user")]);
    });
    expect(result.current.rows).toBeNull();
  });

  it("moves a trace row with its run and builds a row for a new run", () => {
    const pushed = {
      ...run("r1", "failed", "2026-11-01T00:00:00Z"),
      error_message: "boom",
      finished_at: "2026-11-01T00:01:00Z",
    };
    const row = traceFromRun({ ...pushed, status: "running", error_message: null, finished_at: null });
    expect(row).toMatchObject({ trace_id: "r1", status: "running", finished_at: null });
    const moved: TraceRow = traceWithRun(row, pushed);
    expect(moved).toMatchObject({ status: "failed", error: "boom", finished_at: "2026-11-01T00:01:00Z" });
    expect(upsertRun([pushed], { ...pushed, status: "succeeded" })[0]!.status).toBe("succeeded");
  });

  it("moves a trace row's tokens and duration with its run and keeps counts the run does not carry", () => {
    const running = { ...run("r1", "running", "2026-11-01T00:00:00Z"), started_at: "2026-11-01T00:00:00Z" };
    const row: TraceRow = { ...traceFromRun(running), call_count: 3, tokens_in: 100, tokens_out: 20 };
    const done = { ...running, status: "succeeded" as const, tokens: 500, finished_at: "2026-11-01T00:00:02.500Z" };
    const moved = traceWithRun(row, done);
    expect(moved).toMatchObject({ status: "succeeded", duration_ms: 2500, call_count: 3, tokens_out: 20 });
    expect(moved.tokens_in + moved.tokens_out).toBe(500);
    expect(traceWithRun(moved, { ...done, tokens: 0 })).toMatchObject({ tokens_in: moved.tokens_in, call_count: 3 });
    expect(traceFromRun(done)).toMatchObject({ duration_ms: 2500, tokens_in: 500 });

    const summary = {
      totals: {
        traces: 4,
        failed_traces: 0,
        calls: 9,
        tool_calls: 0,
        errors: 0,
        tokens_in: 1000,
        tokens_out: 100,
        reasoning_tokens: 0,
        cost_usd: 0,
        p50_ms: 0,
        p95_ms: 0,
      },
      by_day: [],
    } satisfies ActivitySummary;
    expect(summaryWithTrace(summary, row, moved).totals).toMatchObject({ traces: 4, tokens_in: 1380, tokens_out: 100 });
    const failed = summaryWithTrace(summary, undefined, traceFromRun({ ...done, status: "failed" })).totals;
    expect(failed).toMatchObject({ traces: 5, failed_traces: 1, tokens_in: 1500 });
  });

  it("takes a finished run's call and tool counts and never lowers them", () => {
    const running = { ...run("r1", "running", "2026-11-01T00:00:00Z"), started_at: "2026-11-01T00:00:00Z" };
    const row = traceFromRun(running);
    expect(row).toMatchObject({ call_count: 0, tool_count: 0 });
    const done = {
      ...running,
      status: "succeeded" as const,
      finished_at: "2026-11-01T00:00:02Z",
      call_count: 3,
      tool_count: 1,
    };
    const moved = traceWithRun(row, done);
    expect(moved).toMatchObject({ call_count: 3, tool_count: 1 });
    expect(traceFromRun(done)).toMatchObject({ call_count: 3, tool_count: 1 });
    // A frame without counts, or with older ones, keeps what the row holds.
    expect(traceWithRun(moved, { ...done, call_count: undefined, tool_count: undefined })).toMatchObject({
      call_count: 3,
      tool_count: 1,
    });
    expect(traceWithRun({ ...moved, call_count: 5 }, done)).toMatchObject({ call_count: 5, tool_count: 1 });

    const summary = {
      totals: {
        traces: 1,
        failed_traces: 0,
        calls: 0,
        tool_calls: 0,
        errors: 0,
        tokens_in: 0,
        tokens_out: 0,
        reasoning_tokens: 0,
        cost_usd: 0,
        p50_ms: 0,
        p95_ms: 0,
      },
      by_day: [],
    } satisfies ActivitySummary;
    expect(summaryWithTrace(summary, row, moved).totals).toMatchObject({ calls: 3, tool_calls: 1 });
  });
});
