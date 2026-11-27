// @vitest-environment happy-dom
// The conversation page reads a chat the way a manager browses it: the
// trigger message, one run row, the agent's reply; the run row opens the
// run detail.
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationDetail, ConversationRow, TraceRow } from "./agents-api";

const api = vi.hoisted(() => ({
  getConversation: vi.fn(),
  getActivitySummary: vi.fn(),
  listConversations: vi.fn(),
  listTraces: vi.fn(),
}));
vi.mock("./agents-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agents-api")>()),
  ...api,
}));

import { ActivityPage, ConversationPage } from "../../../../control-center/src/agents/ActivityPage";
import { AGENTS_ACTIVITY } from "./agents-route";
import { applyActivityConversation, applyActivityRun, resetAgentSlices, traceFromRun } from "./agents-store";
import { makeRun } from "./test-fixtures";

const detail: ConversationDetail = {
  conversation: {
    id: "c1",
    title: "Quarterly numbers",
    owner: { id: "u1", email: "ada@example.com", display_name: "Ada Lovelace" },
    agent: { id: "a1", name: "Echo" },
    thread: {
      id: "t1",
      chat_id: "c1",
      type: "subagent",
      parent_thread_id: "t0",
      parent_chat_id: "c0",
      parent_title: "Parent work",
    },
    created_at: "2026-11-01T10:00:00Z",
    last_activity_at: "2026-11-01T10:02:00Z",
    messages: 2,
    runs: 1,
    open_runs: 0,
    failed_runs: 0,
    archived: false,
    deleted: false,
    tokens_in: 100,
    tokens_out: 50,
    cost_usd: 0.01,
    errors: 0,
  },
  items: [
    {
      kind: "message",
      seq: 1,
      role: "user",
      text: "Summarize the quarter",
      ts: "2026-11-01T09:59:59Z",
    },
    {
      kind: "message",
      seq: 2,
      role: "assistant",
      text: "The quarter closed above plan.",
      ts: "2026-11-01T10:00:30Z",
    },
    {
      kind: "run",
      ts: "2026-11-01T10:00:30Z",
      trigger: "Summarize the quarter",
      steps: 7,
      call_count: 3,
      tool_count: 4,
      reply: true,
      run: {
        id: "r1",
        agent_id: "a1",
        agent_name: "Echo",
        trigger: "message",
        status: "succeeded",
        summary: "Wrote the summary",
        error_message: "",
        tokens: 150,
        started_at: "2026-11-01T10:00:00Z",
        finished_at: "2026-11-01T10:00:30Z",
      },
    },
  ],
  has_more: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("conversation page", () => {
  it("reads the trigger, the run row and the reply, and opens the run", async () => {
    api.getConversation.mockResolvedValue(detail);
    const onNavigate = vi.fn();
    render(<ConversationPage chatId="c1" role="admin" onNavigate={onNavigate} />);

    await waitFor(() => expect(screen.getByText("Quarterly numbers")).toBeTruthy());
    expect(screen.getByText("Ada Lovelace · Echo")).toBeTruthy();
    expect(screen.getByText("Summarize the quarter")).toBeTruthy();
    expect(screen.getByText("Echo run")).toBeTruthy();
    expect(screen.getByText(/7 steps/)).toBeTruthy();
    expect(screen.getByText("The quarter closed above plan.")).toBeTruthy();

    fireEvent.click(screen.getByText("Echo run"));
    expect(onNavigate).toHaveBeenCalledWith({ view: "run", runId: "r1" });

    fireEvent.click(screen.getByText("Parent thread"));
    expect(onNavigate).toHaveBeenCalledWith({ view: "chat", chatId: "c0" });
  });

  it("keeps committed socket messages and Run status over a late HTTP seed", async () => {
    let showSnapshot!: (value: ConversationDetail) => void;
    api.getConversation.mockReturnValueOnce(
      new Promise((resolve) => {
        showSnapshot = resolve;
      }),
    );
    render(<ConversationPage chatId="c1" role="admin" onNavigate={() => {}} />);
    const run = detail.items.find((item) => item.kind === "run")!;
    const message = { kind: "message", seq: 4, role: "assistant", text: "A live reply", ts: run.ts } as const;
    act(() =>
      applyActivityConversation({
        type: "activity_conversation",
        chat_id: "c1",
        detail: {
          ...detail,
          items: [{ ...run, run: { ...run.run, status: "failed" } }, message],
        },
      }),
    );
    await act(async () =>
      showSnapshot({
        ...detail,
        items: [{ ...run, run: { ...run.run, status: "running" } }],
      }),
    );
    expect(await screen.findByText("Failed")).toBeTruthy();
    expect(screen.getByText("A live reply")).toBeTruthy();
    expect(screen.queryByText("Running")).toBeNull();
    expect(api.getConversation).toHaveBeenCalledTimes(1);
  });

  it("keeps earlier pages and avoids duplicate messages when a new socket snapshot arrives", async () => {
    const older = {
      kind: "message",
      seq: 0,
      role: "user",
      text: "An earlier message",
      ts: "2026-11-01T09:00:00Z",
    } as const;
    const newer = {
      kind: "message",
      seq: 3,
      role: "assistant",
      text: "A later message",
      ts: "2026-11-01T10:03:00Z",
    } as const;
    api.getConversation.mockResolvedValueOnce({ ...detail, has_more: true });
    api.getConversation.mockResolvedValueOnce({ ...detail, items: [older], has_more: false });
    render(<ConversationPage chatId="c1" role="admin" onNavigate={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Load earlier messages" }));
    expect(await screen.findByText(older.text)).toBeTruthy();
    expect(api.getConversation).toHaveBeenLastCalledWith("c1", { limit: 200, before: 1 });

    act(() =>
      applyActivityConversation({
        type: "activity_conversation",
        chat_id: "c1",
        detail: { ...detail, items: [...detail.items, newer], has_more: true },
      }),
    );
    expect(screen.getByText(older.text)).toBeTruthy();
    expect(screen.getByText(newer.text)).toBeTruthy();
    expect(screen.getAllByText("The quarter closed above plan.")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Load earlier messages" })).toBeNull();
    expect(api.getConversation).toHaveBeenCalledTimes(2);
  });

  it("requests a new socket snapshot on Refresh and keeps it over the analytics read", async () => {
    api.getConversation.mockResolvedValue(detail);
    const onResync = vi.fn(() =>
      applyActivityConversation({
        type: "activity_conversation",
        chat_id: "c1",
        detail: { ...detail, conversation: { ...detail.conversation, title: "Refreshed title" } },
      }),
    );
    render(<ConversationPage chatId="c1" role="admin" onNavigate={() => {}} onResync={onResync} />);
    await screen.findByText("Quarterly numbers");
    act(() => applyActivityConversation({ type: "activity_conversation", chat_id: "c1", detail }));

    fireEvent.click(screen.getByRole("button", { name: "Refresh thread" }));
    expect(onResync).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(api.getConversation).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Refreshed title")).toBeTruthy();
    expect(screen.queryByText("Quarterly numbers")).toBeNull();
  });

  it("clears only the selected Conversation and ignores a late seed after it is unavailable", async () => {
    let showSnapshot!: (value: ConversationDetail) => void;
    api.getConversation.mockReturnValueOnce(
      new Promise((resolve) => {
        showSnapshot = resolve;
      }),
    );
    render(<ConversationPage chatId="c1" role="admin" onNavigate={() => {}} />);
    const frame = { type: "activity_conversation", chat_id: "c1" } as const;

    act(() => applyActivityConversation({ ...frame, detail }));
    expect(screen.getByText("Quarterly numbers")).toBeTruthy();
    act(() => applyActivityConversation({ ...frame, chat_id: "c2", detail: null }));
    expect(screen.getByText("Quarterly numbers")).toBeTruthy();
    act(() => applyActivityConversation({ ...frame, detail: null }));
    await act(async () => showSnapshot(detail));
    expect(screen.getByText("This conversation is unavailable.")).toBeTruthy();
    expect(screen.queryByText("Quarterly numbers")).toBeNull();
  });

  it("hides the owner line for a member", async () => {
    api.getConversation.mockResolvedValue(detail);
    render(<ConversationPage chatId="c1" role="member" onNavigate={() => {}} />);
    await waitFor(() => expect(screen.getByText("Quarterly numbers")).toBeTruthy());
    expect(screen.queryByText("Cost")).toBeNull();
  });
});

it("applies background Thread counts that arrive before and after the Activity snapshot", async () => {
  const row: ConversationRow = { ...detail.conversation, internal: true, open_runs: 1 };
  let showSnapshot!: (value: { conversations: ConversationRow[]; total: number }) => void;
  api.listConversations.mockReturnValueOnce(
    new Promise((resolve) => {
      showSnapshot = resolve;
    }),
  );
  api.getActivitySummary.mockRejectedValueOnce(new Error("analytics unavailable"));
  render(
    <ActivityPage
      filters={{ ...AGENTS_ACTIVITY.filters, tab: "chats", background: true }}
      onFiltersChange={vi.fn()}
      onNavigate={vi.fn()}
      role="admin"
    />,
  );

  const run = makeRun({ internal: true, thread_id: "t1", status: "failed" });
  act(() =>
    applyActivityRun({
      type: "activity_run",
      run,
      counts: { runs: 1, open_runs: 0, failed_runs: 1 },
    }),
  );
  await act(async () => showSnapshot({ conversations: [row], total: 1 }));
  expect(screen.getByText("1 failed run")).toBeTruthy();
  expect(screen.queryByText("Running")).toBeNull();

  act(() =>
    applyActivityRun({
      type: "activity_run",
      run: { ...run, status: "running" },
      counts: { runs: 2, open_runs: 1, failed_runs: 1 },
    }),
  );
  expect(screen.getByText("Running")).toBeTruthy();
  expect(api.listConversations).toHaveBeenCalledTimes(1);
});

it("applies Run frames over Activity snapshots during first load and reconnect", async () => {
  const seeds: ((value: { traces: TraceRow[]; total: number }) => void)[] = [];
  api.listTraces.mockImplementation(
    () => new Promise<{ traces: TraceRow[]; total: number }>((resolve) => seeds.push(resolve)),
  );
  api.getActivitySummary.mockResolvedValue(null);
  const running = makeRun({ id: "r1", summary: "Old snapshot title" });
  const finished = { ...running, status: "succeeded" as const, summary: "Finished once" };
  const queued = makeRun({ id: "r2", status: "queued", summary: "New queued run" });
  const push = (run: ReturnType<typeof makeRun>) => applyActivityRun({ type: "activity_run", run, counts: null });

  render(
    <ActivityPage
      filters={{ ...AGENTS_ACTIVITY.filters, tab: "traces" }}
      onFiltersChange={vi.fn()}
      onNavigate={vi.fn()}
      role="admin"
    />,
  );
  act(() => {
    push(finished);
    push(finished);
    push(queued);
  });
  await act(async () => seeds[0]!({ traces: [traceFromRun(running)], total: 1 }));
  expect(screen.queryByText("Old snapshot title")).toBeNull();
  expect(screen.getByText("Finished once")).toBeTruthy();
  expect(screen.getByText("New queued run")).toBeTruthy();
  expect(screen.getByText("2 runs")).toBeTruthy();

  // The new socket can deliver a frame before React begins its reseed effect.
  act(() => {
    resetAgentSlices();
    push({ ...queued, status: "failed", summary: "Failed during reconnect" });
  });
  expect(api.listTraces).toHaveBeenCalledTimes(2);
  await act(async () => seeds[1]!({ traces: [traceFromRun(finished), traceFromRun(queued)], total: 2 }));
  expect(screen.queryByText("New queued run")).toBeNull();
  expect(screen.getByText("Failed during reconnect")).toBeTruthy();
  expect(screen.getByText("2 runs")).toBeTruthy();
});
