// @vitest-environment happy-dom
// The run page follows its run's frames: the header takes the pushed tokens
// and duration, and the frame that finishes the run re-reads the trace once
// so the transcript shows the final spans.
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRun, SpanRow, TraceRow } from "./agents-api";
import { traceFromRun } from "./agents-store";

const api = vi.hoisted(() => ({ getTrace: vi.fn(), getRun: vi.fn() }));
vi.mock("./agents-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agents-api")>()),
  ...api,
}));

import { applyAgentRun, clearAgentState, runFinishes } from "./agents-store";
import { RunDetailPage } from "./TraceDetail";

const running: AgentRun = {
  id: "r1", agent_id: "a1", agent_name: "Echo", depth: 0, trigger: "manual", status: "running",
  created_at: "2026-11-01T00:00:00Z", started_at: "2026-11-01T00:00:00Z", summary: null,
};

function span(id: string, output: string): SpanRow {
  return {
    span_id: id, trace_id: "r1", run_id: "r1", parent_span_id: null, name: "model", span_type: "llm",
    status: "ok", start_time: "2026-11-01T00:00:01Z", end_time: "2026-11-01T00:00:02Z", duration_ms: 1000,
    model: "m", provider: "p", tokens_in: 10, tokens_out: 5, reasoning_tokens: 0, cost_usd: 0, error: "",
    input: "", output, request_id: null, caller: "model", session_id: null, chat_id: null, attributes: {},
  };
}

afterEach(() => {
  cleanup();
  clearAgentState();
  vi.clearAllMocks();
});

describe("run page", () => {
  it("knows which frame finishes a run", () => {
    expect(runFinishes("running", { ...running, status: "succeeded" })).toBe(true);
    expect(runFinishes("succeeded", { ...running, status: "succeeded" })).toBe(false);
    expect(runFinishes("running", running)).toBe(false);
    expect(runFinishes(null, { ...running, status: "failed" })).toBe(false);
  });

  it("moves the header with the pushed run and re-reads the trace once when the run finishes", async () => {
    const first: TraceRow = traceFromRun(running);
    api.getTrace.mockResolvedValueOnce({ trace: first, spans: [span("s1", "first")], children: [] });
    api.getRun.mockResolvedValue(running);
    render(<RunDetailPage runId="r1" view="tree" role="member" onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Running")).toBeTruthy());

    const done: AgentRun = { ...running, status: "succeeded", tokens: 1500, finished_at: "2026-11-01T00:00:03Z" };
    const stale: TraceRow = { ...first, call_count: 2, tokens_in: 20, tokens_out: 10 };
    api.getTrace.mockResolvedValueOnce({ trace: stale, spans: [span("s1", "first"), span("s2", "final")], children: [] });
    api.getRun.mockResolvedValue(done);
    act(() => applyAgentRun(done));

    await waitFor(() => expect(api.getTrace).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/3\.0s · 1\.5k tokens/)).toBeTruthy());
    expect(screen.getByText("Succeeded")).toBeTruthy();

    act(() => applyAgentRun(done));
    expect(api.getTrace).toHaveBeenCalledTimes(2);
  });
});
