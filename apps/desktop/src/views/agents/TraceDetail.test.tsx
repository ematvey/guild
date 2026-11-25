// @vitest-environment happy-dom
// The run page follows its run's frames: the header takes the pushed tokens
// and duration, and the frame that finishes the run re-reads the trace once
// so the transcript shows the final spans.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRun, SpanRow, TraceRow } from "./agents-api";
import { makeRun } from "./test-fixtures";
import { traceFromRun } from "./agents-store";

const api = vi.hoisted(() => ({ getTrace: vi.fn(), getRun: vi.fn() }));
vi.mock("./agents-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agents-api")>()),
  ...api,
}));

import { applyActivityRun, clearAgentState, runFinishes } from "./agents-store";
import { RunDetailPage } from "./TraceDetail";

const running: AgentRun = makeRun({ agent_name: "Echo", started_at: "2026-11-01T00:00:00Z" });

function span(id: string, output: string): SpanRow {
  return {
    span_id: id,
    trace_id: "r1",
    run_id: "r1",
    parent_span_id: null,
    name: "model",
    span_type: "llm",
    status: "ok",
    start_time: "2026-11-01T00:00:01Z",
    end_time: "2026-11-01T00:00:02Z",
    duration_ms: 1000,
    model: "m",
    provider: "p",
    tokens_in: 10,
    tokens_out: 5,
    reasoning_tokens: 0,
    cost_usd: 0,
    error: "",
    input: "",
    output,
    request_id: null,
    caller: "model",
    session_id: null,
    chat_id: null,
    attributes: {},
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
    api.getRun.mockResolvedValue({ run: running, thread: null });
    render(<RunDetailPage runId="r1" view="tree" role="member" onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Running")).toBeTruthy());

    const done: AgentRun = { ...running, status: "succeeded", tokens: 1500, finished_at: "2026-11-01T00:00:03Z" };
    const stale: TraceRow = { ...first, call_count: 2, tokens_in: 20, tokens_out: 10 };
    api.getTrace.mockResolvedValueOnce({
      trace: stale,
      spans: [span("s1", "first"), span("s2", "final")],
      children: [],
    });
    api.getRun.mockResolvedValue({ run: done, thread: null });
    act(() => applyActivityRun({ type: "activity_run", run: done, counts: null }));

    await waitFor(() => expect(api.getTrace).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByText(/3\.0s · 1\.5k tokens/)).toBeTruthy());
    expect(screen.getByText("Succeeded")).toBeTruthy();

    act(() => applyActivityRun({ type: "activity_run", run: done, counts: null }));
    expect(api.getTrace).toHaveBeenCalledTimes(2);
  });

  it("renders newly durable steps from the watching socket when telemetry is unavailable", async () => {
    api.getRun.mockResolvedValueOnce({ run: running, thread: null });
    api.getTrace.mockRejectedValue(new Error("analytics unavailable"));
    render(<RunDetailPage runId="r1" view="transcript" role="member" onNavigate={() => {}} />);
    expect(await screen.findByText("Running")).toBeTruthy();
    act(() => applyActivityRun({
      type: "activity_run",
      run: { ...running, status: "succeeded" },
      counts: null,
      steps: [{ kind: "assistant", detail: "The new durable response." }],
    }));
    expect(await screen.findByText("The new durable response.")).toBeTruthy();
    expect(api.getRun).toHaveBeenCalledTimes(1);
  });

  it("clears a revoked run and drops telemetry that was already in flight", async () => {
    const step = { kind: "assistant", detail: "Private transcript text" } as const;
    api.getRun.mockResolvedValue({ run: { ...running, steps: [step] }, thread: null });
    let finishTrace!: (value: unknown) => void;
    api.getTrace.mockReturnValue(
      new Promise((resolve) => {
        finishTrace = resolve;
      }),
    );
    render(<RunDetailPage runId="r1" view="transcript" role="admin" onNavigate={() => {}} />);
    expect(await screen.findByText(step.detail)).toBeTruthy();
    act(() => applyActivityRun({ type: "activity_run_unavailable", run_id: "r1" }));
    expect(screen.getByText("This run is unavailable.")).toBeTruthy();
    expect(screen.queryByText(step.detail)).toBeNull();
    await act(async () =>
      finishTrace({ trace: traceFromRun(running), spans: [span("s1", "Private telemetry")], children: [] }),
    );
    expect(screen.queryByText("Private telemetry")).toBeNull();
    expect(screen.queryByText("Running")).toBeNull();
  });

  it("loads recorded telemetry for a background Run while preserving Thread navigation", async () => {
    api.getRun.mockResolvedValueOnce({
      run: {
        ...running,
        internal: true,
        status: "succeeded",
        steps: [{ kind: "assistant", detail: "Saved memory." }],
      },
      thread: { chat_id: "c1", parent_chat_id: null },
    });
    api.getTrace.mockResolvedValueOnce({
      trace: traceFromRun(running),
      spans: [span("s1", "Recorded model output.")],
      children: [],
    });
    const onNavigate = vi.fn();
    render(<RunDetailPage runId="r1" view="transcript" role="admin" onNavigate={onNavigate} onOpenChat={vi.fn()} />);
    expect(await screen.findByText("Saved memory.")).toBeTruthy();
    expect(api.getTrace).toHaveBeenCalledWith("r1");
    expect(screen.queryByRole("button", { name: "Open chat" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Thread" }));
    expect(onNavigate).toHaveBeenCalledWith({ view: "chat", chatId: "c1" });
  });

  it("renders the saved run while telemetry is pending and keeps it after a trace failure", async () => {
    let rejectTrace!: (reason: Error) => void;
    api.getTrace.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectTrace = reject; }));
    api.getRun.mockResolvedValueOnce({ run: { ...running, status: "succeeded" }, thread: null });
    render(<RunDetailPage runId="r1" view="transcript" role="member" onNavigate={() => {}} />);
    expect(await screen.findByText("Succeeded")).toBeTruthy();
    await act(async () => rejectTrace(new Error("no such trace")));
    expect(screen.getByText("Succeeded")).toBeTruthy();
    expect(screen.queryByText("no such trace")).toBeNull();
  });

  it("requires the saved run on a run URL", async () => {
    api.getRun.mockRejectedValueOnce(new Error("no such run"));
    render(<RunDetailPage runId="r1" view="transcript" role="member" onNavigate={() => {}} />);
    expect(await screen.findByText("no such run")).toBeTruthy();
    expect(api.getTrace).not.toHaveBeenCalled();
  });

  it("goes back to the thread the run belongs to", async () => {
    const trace = { ...traceFromRun(running), session_id: "c1" };
    api.getTrace.mockResolvedValueOnce({ trace, spans: [span("s1", "hi")], children: [] });
    api.getRun.mockResolvedValue({ run: running, thread: null });
    const onNavigate = vi.fn();
    render(<RunDetailPage runId="r1" view="tree" role="member" onNavigate={onNavigate} />);
    const back = await screen.findByRole("button", { name: "Thread" });
    fireEvent.click(back);
    expect(onNavigate).toHaveBeenCalledWith({ view: "chat", chatId: "c1" });
  });
});
