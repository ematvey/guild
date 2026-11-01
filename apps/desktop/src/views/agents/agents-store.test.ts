// @vitest-environment happy-dom
// The agent store applies pushed frames: the list replaces, a run upserts
// into its agent's loaded list and reaches run listeners, a per-agent slice
// seeds over HTTP only until a frame owns it, and a reconnect re-seeds.
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Agent, AgentRun, AgentThread, TraceRow } from "./agents-api";

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
  traceFromRun,
  traceWithRun,
  upsertRun,
  useAgentList,
  useAgentRuns,
  useAgentThreads,
} from "./agents-store";

function run(id: string, status: AgentRun["status"], created_at: string): AgentRun {
  return { id, agent_id: "a1", depth: 0, trigger: "manual", status, created_at, summary: null };
}

function thread(id: string, title: string): AgentThread {
  return {
    id, agent_id: "a1", chat_id: `chat-${id}`, title, title_locked: false, type: "user",
    is_default: false, created_at: "2026-11-01T00:00:00Z", last_activity_at: "2026-11-01T00:00:00Z",
  };
}

afterEach(() => {
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
    await waitFor(() => expect(result.current).not.toBeNull());
    act(() => applyAgentRun(run("r2", "running", "2026-11-02T00:00:00Z")));
    expect(result.current?.map((r) => `${r.id}:${r.status}`)).toEqual(["r2:running", "r1:succeeded"]);
    act(() => applyAgentRun(run("r2", "succeeded", "2026-11-02T00:00:00Z")));
    expect(result.current?.map((r) => `${r.id}:${r.status}`)).toEqual(["r2:succeeded", "r1:succeeded"]);
    expect(heard).toEqual(["r2:running", "r2:succeeded"]);
    expect(api.listAgentRuns).toHaveBeenCalledTimes(1);
    off();
  });

  it("lets a thread frame win over a late seed and re-seeds after a reconnect", async () => {
    let resolveSeed: (rows: AgentThread[]) => void = () => {};
    api.listAgentThreads.mockReturnValueOnce(new Promise((resolve) => { resolveSeed = resolve; }));
    const { result } = renderHook(() => useAgentThreads("a1"));
    act(() => applyAgentThreads("a1", [thread("t1", "pushed")]));
    await act(async () => { resolveSeed([thread("t1", "stale")]); });
    expect(result.current?.map((t) => t.title)).toEqual(["pushed"]);

    api.listAgentThreads.mockResolvedValueOnce([thread("t1", "after reconnect")]);
    act(() => resetAgentSlices());
    await waitFor(() => expect(result.current?.map((t) => t.title)).toEqual(["after reconnect"]));
  });

  it("moves a trace row with its run and builds a row for a new run", () => {
    const pushed = { ...run("r1", "failed", "2026-11-01T00:00:00Z"), error_message: "boom", finished_at: "2026-11-01T00:01:00Z" };
    const row = traceFromRun({ ...pushed, status: "running", error_message: null, finished_at: null });
    expect(row).toMatchObject({ trace_id: "r1", status: "running", finished_at: null });
    const moved: TraceRow = traceWithRun(row, pushed);
    expect(moved).toMatchObject({ status: "failed", error: "boom", finished_at: "2026-11-01T00:01:00Z" });
    expect(upsertRun([pushed], { ...pushed, status: "succeeded" })[0]!.status).toBe("succeeded");
  });
});
