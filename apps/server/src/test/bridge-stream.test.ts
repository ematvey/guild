// The bridge's generation-stream contract (the live-frame source of the
// member-socket feed): deltas/tool frames/terminals emitted in order, the
// generation identity = the originating command id, one terminal per run,
// and the byte-exact StreamEvent rendering (ryu floats).

import { describe, expect, it } from "vitest";
import { ChatBridge, type BridgeDeps, type GenerationStreamSink } from "../chats/bridge.js";
import type { ThreadEventRow } from "../platform/domain/thread-events.js";
import { streamEventWire, type StreamWireEvent } from "../hub/protocol.js";
import { uuidv7 } from "../platform/time.js";

function fakeDeps(commands: { id: string; position: number | null }[]): BridgeDeps & { rows: ThreadEventRow[] } {
  const rows: ThreadEventRow[] = [];
  let seq = 0;
  return {
    rows,
    threads: {
      latestTurn: async () => 0,
      appendEvent: async (chatId: string, event: ThreadEventRow["event"]) => {
        const row: ThreadEventRow = { id: uuidv7(), chat_id: chatId, seq: (seq += 1), event, created_at: "2026-10-04T00:00:00.000000Z" };
        rows.push(row);
        return row;
      },
    } as never,
    chats: { setGenerating: async () => {} } as never,
    turnCommands: {
      byInvocation: async () =>
        commands.map((c) => ({ ...c, org_id: "o", user_id: "u", chat_id: "c", request: {}, payload: {}, status: "submitted", invocation_id: null })) as never,
      begin: async () => true,
      finish: async () => {},
    } as never,
    routeSupportsImages: async () => false,
    log: { warn() {}, error() {}, info() {} } as never,
  };
}

interface SinkRecord {
  opened: [string, string][];
  events: [string, StreamWireEvent][];
  closed: string[];
  dirtied: string[];
}

function sink(): GenerationStreamSink & { record: SinkRecord } {
  const record: SinkRecord = { opened: [], events: [], closed: [], dirtied: [] };
  return {
    record,
    open: (chatId, generationId) => record.opened.push([chatId, generationId]),
    event: (chatId, event) => record.events.push([chatId, event]),
    dirty: (chatId) => record.dirtied.push(chatId),
    close: (chatId) => record.closed.push(chatId),
  };
}

function assistantEntry(text: string, stopReason: string, usage: { input: number; output: number; total: number }): unknown {
  return {
    id: 1,
    kind: "pi.assistant",
    model: [
      {
        role: "assistant",
        content: [{ type: "text", text }],
        model: "GLM-Test-Model",
        usage: { input: usage.input, output: usage.output, cost: { total: usage.total } },
        stopReason,
      },
    ],
  };
}

describe("bridge generation stream", () => {
  it("streams deltas, tool frames, and one terminal per run in order", async () => {
    const deps = fakeDeps([{ id: "cmd-1", position: 5 }]);
    const bridge = new ChatBridge(deps);
    const out = sink();
    bridge.setStream(out);
    bridge.bind("conv-1", "chat-1", "org-1");

    const start = { type: "run_start", inputs: [1n] } as never;
    await bridge.handle("conv-1", [start]);
    expect(out.record.opened).toEqual([["chat-1", "cmd-1"]]);

    // The first partial commits as message_start with its content so far.
    await bridge.handle("conv-1", [
      {
        type: "message_start",
        message: { role: "assistant", content: [{ type: "text", text: "par" }], model: "GLM-Test-Model" },
      } as never,
    ]);
    await bridge.handle("conv-1", [
      {
        type: "message_update",
        usage: {},
        changes: [{ type: "text_delta", contentIndex: 0, delta: "tial" }],
      } as never,
    ]);
    await bridge.handle("conv-1", [
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "ls" } } as never,
    ]);
    await bridge.handle("conv-1", [
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        entry: {
          id: 2,
          kind: "pi.tool-result",
          model: [{ role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: "ok" }], isError: false }],
        } as never,
      } as never,
    ]);
    await bridge.handle("conv-1", [{ type: "message_end", entry: assistantEntry("partial", "toolUse", { input: 3, output: 2, total: 0.000014 }) } as never]);
    await bridge.handle("conv-1", [{ type: "run_end", inputs: [1n] } as never]);

    const events = out.record.events.map(([, e]) => e);
    expect(events).toEqual([
      { type: "delta", content: "par" },
      { type: "delta", content: "tial" },
      { type: "tool_started", call_id: "call-1", name: "bash", arguments: '{"command":"ls"}', executor: "server" },
      { type: "tool_completed", call_id: "call-1", name: "bash", content: "ok", is_error: false },
      {
        type: "done",
        message_id: deps.rows.find((r) => r.event.type === "assistant_message")!.id,
        cost_usd: 0.000014,
        tokens_in: 3,
        tokens_out: 2,
      },
    ]);
    expect(out.record.closed).toEqual(["chat-1"]);
    // The buffers rode the deltas too (the view poll's text).
    expect(bridge.state("conv-1").buffers.text).toBe("");
    expect(deps.rows.map((r) => r.event.type)).toEqual(["tool_result", "assistant_message"]);
  });

  it("coalesces trailing reasoning: thinking after text started is buffered, not streamed", async () => {
    // Local vLLM emits a reasoning delta after the answer has begun; the
    // live stream must keep the thought block open (the tail joins the
    // durable reasoning block at the turn boundary instead of splitting
    // the answer into [thinking][text][thinking][text]).
    const deps = fakeDeps([{ id: "cmd-3", position: 1 }]);
    const bridge = new ChatBridge(deps);
    const out = sink();
    bridge.setStream(out);
    bridge.bind("conv-1", "chat-1", "org-1");

    await bridge.handle("conv-1", [{ type: "run_start", inputs: [1n] } as never]);
    await bridge.handle("conv-1", [
      {
        type: "message_update",
        usage: {},
        changes: [
          { type: "thinking_delta", contentIndex: 0, delta: "long thought" },
          { type: "text_delta", contentIndex: 1, delta: "answer start" },
          { type: "thinking_delta", contentIndex: 0, delta: " trailing tail" },
          { type: "text_delta", contentIndex: 1, delta: " rest" },
        ],
      } as never,
    ]);

    const events = out.record.events.map(([, e]) => e);
    expect(events).toEqual([
      { type: "thinking_delta", content: "long thought" },
      { type: "delta", content: "answer start" },
      { type: "delta", content: " rest" },
    ]);
    // The tail still lands in the view poll's thinking buffer.
    expect(bridge.state("conv-1").buffers.thinking).toBe("long thought trailing tail");
  });

  it("a run failure sends Error; a stop sends the zero-usage Done with the last event id", async () => {
    const deps = fakeDeps([{ id: "cmd-2", position: 1 }]);
    const bridge = new ChatBridge(deps);
    const out = sink();
    bridge.setStream(out);
    bridge.bind("conv-1", "chat-1", "org-1");

    await bridge.handle("conv-1", [{ type: "run_start", inputs: [1n] } as never]);
    await bridge.handle("conv-1", [
      { type: "task_failed", taskId: 7n, kind: "pi.generation", message: "provider exploded" } as never,
    ]);
    await bridge.handle("conv-1", [{ type: "run_end", inputs: [1n] } as never]);
    const events = out.record.events.map(([, e]) => e);
    expect(events).toEqual([{ type: "error", code: "provider", message: "provider exploded" }]);
    expect(out.record.closed).toEqual(["chat-1"]);
    // The failure is also persisted: the thread keeps the error card across
    // reloads and lost sockets.
    expect(deps.rows.map((r) => r.event.type)).toEqual(["turn_error"]);
    expect(deps.rows[0]!.event).toEqual({ type: "turn_error", message: "provider exploded" });

    // A stopped run: the interrupted prefix persists (no inline Done), the
    // run end sends the zero-usage Done with the interrupted row's id.
    const out2 = sink();
    const deps2 = fakeDeps([{ id: "cmd-3", position: 1 }]);
    const bridge2 = new ChatBridge(deps2);
    bridge2.setStream(out2);
    bridge2.bind("conv-2", "chat-2", "org-1");
    await bridge2.handle("conv-2", [{ type: "run_start", inputs: [1n] } as never]);
    await bridge2.handle("conv-2", [
      // pi always emits message_start before message_end (streamed or not).
      { type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "stopped mid-sentence" }], model: "GLM-Test-Model" } } as never,
      { type: "message_end", entry: assistantEntry("stopped mid-sentence", "aborted", { input: 0, output: 0, total: 0 }) } as never,
    ]);
    await bridge2.handle("conv-2", [{ type: "run_end", inputs: [1n] } as never]);
    const events2 = out2.record.events.map(([, e]) => e);
    expect(events2).toEqual([
      { type: "delta", content: "stopped mid-sentence" },
      { type: "done", message_id: expect.any(String), cost_usd: 0, tokens_in: 0, tokens_out: 0 },
    ]);
    const interrupted = bridge2.state("conv-2").lastEventId;
    expect((events2[1] as { message_id: string }).message_id).toBe(interrupted);
    expect(deps2.rows[0]!.event.type).toBe("assistant_message");
  });

  it("a pi.compaction entry lands as a compaction event, string or block content", async () => {
    const wrapped = (summary: string) =>
      `The conversation history before this point was compacted into the following summary:\n\n<summary>\n${summary}\n</summary>`;
    // pi-durable compactions carry the summary as text blocks.
    const deps = fakeDeps([]);
    const bridge = new ChatBridge(deps);
    bridge.bind("conv-1", "chat-1", "org-1");
    await bridge.handle("conv-1", [
      {
        type: "entry_appended",
        entry: {
          id: 9,
          kind: "pi.compaction",
          data: { reason: "threshold" },
          head: 5,
          model: [{ role: "user", content: [{ type: "text", text: wrapped("the user wants TURN-1-OK") }] }],
        } as never,
      },
    ]);
    // The importer's synthetic compactions carry a plain string.
    await bridge.handle("conv-1", [
      {
        type: "entry_appended",
        entry: {
          id: 10,
          kind: "pi.compaction",
          data: { reason: "manual" },
          model: [{ role: "user", content: "[Conversation summary so far]\n\nimported summary" }],
        } as never,
      },
    ]);
    expect(deps.rows.map((r) => r.event)).toEqual([
      { type: "compaction", summary: "the user wants TURN-1-OK" },
      { type: "compaction", summary: "[Conversation summary so far]\n\nimported summary" },
    ]);
  });

  it("renders the stream events byte-exactly (ryu floats, declaration order)", () => {
    expect(streamEventWire({ type: "delta", content: "he\"llo" })).toBe('{"type":"delta","content":"he\\"llo"}');
    expect(streamEventWire({ type: "done", message_id: "abc", cost_usd: 0, tokens_in: 3, tokens_out: 2 })).toBe(
      '{"type":"done","message_id":"abc","cost_usd":0.0,"tokens_in":3,"tokens_out":2}',
    );
    expect(streamEventWire({ type: "tool_started", call_id: "c", name: "bash", arguments: "{}", executor: "server" })).toBe(
      '{"type":"tool_started","call_id":"c","name":"bash","arguments":"{}","executor":"server"}',
    );
    expect(streamEventWire({ type: "error", code: "provider", message: "x" })).toBe(
      '{"type":"error","code":"provider","message":"x"}',
    );
  });
});
