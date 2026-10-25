// Thread-reducer tests. Each transition class is seeded from the shipped
// bug it guards against (PLAN-suggestions §7a): replay-during-generating,
// approval upsert mid-stream, optimistic-vs-sync, compacting guard
// (null === null), artifact card on spilled tool_result frames.

import { describe, expect, it } from "vitest";
import {
  artifactCardOf,
  createThreadReducer,
  deriveThread,
  eventsToBlocks,
  reconcilePendingSend,
  threadStateBlocks,
} from "./thread-reducer";
import type { ThreadEvent, ThreadEventRow, ThreadState } from "./thread-events";

function row(seq: number, event: ThreadEvent): ThreadEventRow {
  return { id: `e${seq}`, seq, event, created_at: "t" };
}

/** A durable user_message whose row id is the client's message id — the
 * shape the optimistic-send reconciliation matches on. */
function echo(seq: number, content: string, messageId: string): ThreadEventRow {
  return { id: messageId, seq, event: { type: "user_message", content }, created_at: "t" };
}

function state(
  chatId: string,
  seq: number,
  events: ThreadEventRow[],
  text = "",
  thinking = "",
  generating = true,
): ThreadState {
  return { chat_id: chatId, seq, events, text, thinking, generating };
}

const usage = { tokens_in: 0, tokens_out: 0, cost_usd: 0 };

const assistantText = (text: string, step = 0): ThreadEvent => ({
  type: "assistant_message",
  turn: 1,
  step,
  model: "m",
  usage,
  blocks: [{ type: "text", text }],
});

const artifactMeta = {
  card: {
    card: "artifact",
    id: "11111111-1111-1111-1111-111111111111",
    filename: "report.xlsx",
    content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    size_bytes: 14821,
    path: ".guild/artifacts/chat-1/report.xlsx",
  },
};

/** The server's spilled ToolResult writes the card keys FLAT on meta —
 * the exact shape spill::artifact_meta produces (same keys/values). */
const artifactMetaFlat = {
  card: "artifact",
  id: "11111111-1111-1111-1111-111111111111",
  filename: "report.xlsx",
  content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  size_bytes: 14821,
  path: ".guild/artifacts/chat-1/report.xlsx",
};

describe("applyState: replay-during-generating (incremental, not re-derived)", () => {
  it("applies only the new events per publish; earlier blocks keep identity", () => {
    const r = createThreadReducer();
    r.open("c1");
    const first = r.applyState(
      state("c1", 2, [row(1, { type: "user_message", content: "go" }), row(2, assistantText("hi"))]),
    );
    expect(first.blocks.map((b) => b.key)).toEqual(["1:0", "2:0"]);
    const userBlock = first.blocks[0];

    const second = r.applyState(
      state("c1", 3, [
        row(1, { type: "user_message", content: "go" }),
        row(2, assistantText("hi")),
        row(3, {
          type: "tool_result",
          turn: 1,
          step: 0,
          call_id: "ghost",
          name: "execute",
          content: "out",
          is_error: false,
        }),
      ]),
    );
    expect(second.blocks.map((b) => b.key)).toEqual(["1:0", "2:0", "3:0"]);
    // the publish did not rebuild what it already applied
    expect(second.blocks[0]).toBe(userBlock);
  });

  it("matches the full derivation at every step of a long publish sequence", () => {
    const r = createThreadReducer();
    r.open("c1");
    const events = [
      row(1, { type: "user_message", content: "go" }),
      row(2, {
        type: "assistant_message",
        turn: 1,
        step: 0,
        model: "m",
        usage,
        blocks: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "hi" },
          { type: "tool_call", id: "c9", name: "read_file", arguments: "{}" },
        ],
      }),
      row(3, {
        type: "tool_result",
        turn: 1,
        step: 0,
        call_id: "c9",
        name: "read_file",
        content: "contents",
        is_error: false,
      }),
      row(4, { type: "compaction", summary: "so far" }),
    ];
    // publish 1: the first two events with a live thinking buffer;
    // publish 2: the result lands; publish 3: the compaction
    r.applyState(state("c1", 2, events.slice(0, 2), "", "partial"));
    const r2 = r.applyState(state("c1", 3, events.slice(0, 3), "hi", ""));
    const final = r.applyState(state("c1", 4, events, "", "", false));
    expect(final.blocks).toEqual(eventsToBlocks(events));
    expect(r2.blocks[1].reasoningText).toBe("thinking"); // durable, not buffer
  });

  it("overwrites reflected tokens instead of appending them across publishes", () => {
    const r = createThreadReducer();
    r.open("c1");
    r.applyState(state("c1", 2, [], "hello"));
    const next = r.applyState(state("c1", 3, [], "hello!"));
    expect(next.blocks.filter((b) => b.kind === "text").map((b) => b.text)).toEqual(["hello!"]);
  });

  it("keeps the in-flight thinking block's key stable and its buffer full-replaced", () => {
    const r = createThreadReducer();
    r.open("c1");
    r.applyState(state("c1", 2, [row(1, { type: "user_message", content: "go" })], "", "part one"));
    const first = r.applyState(state("c1", 3, [], "", "part one", true));
    const seed = first.blocks.find((b) => b.kind === "reasoning");
    expect(seed?.key).toBe("live-thinking-c1");
    const second = r.applyState(state("c1", 4, [], "", "part one part two"));
    const grown = second.blocks.find((b) => b.kind === "reasoning");
    expect(grown?.key).toBe("live-thinking-c1");
    expect(grown?.reasoningText).toBe("part one part two");
  });

  it("drops the buffer blocks when the step commits (buffers cleared, event landed)", () => {
    const r = createThreadReducer();
    r.open("c1");
    const step = {
      type: "assistant_message" as const,
      turn: 1,
      step: 0,
      model: "m",
      usage,
      blocks: [
        { type: "reasoning" as const, text: "thought" },
        { type: "text" as const, text: "answer" },
      ],
    };
    r.applyState(state("c1", 2, [], "partial answer", "partial thought"));
    expect(r.applyState(state("c1", 3, [], "", "")).blocks).toHaveLength(0);
    const committed = r.applyState(state("c1", 4, [row(3, step)], "", ""));
    expect(committed.blocks.map((b) => b.kind)).toEqual(["reasoning", "text"]);
    expect(
      committed.blocks.some((b) => b.key.startsWith("live-") || b.key.startsWith("unpersisted")),
    ).toBe(false);
  });

  it("strips ws-streamed buffer orphans at commit, not just the sentinel keys", () => {
    // First-send stream: thinking_delta frames arriving after a text tail
    // open reasoning blocks under per-stream keys (`live-N`); a commit that
    // stripped only `unpersisted-<chat>`/`live-thinking-<chat>` left those
    // orphans rendering above the durable copies — the response showed twice.
    const r = createThreadReducer();
    r.open(null);
    r.optimisticSend({ chatId: null, text: "hello world", key: "cmd-1", sentAt: 0, attachments: [] });
    r.bindPending("c1", "cmd-1");
    r.adopt("c1");
    r.applyState(state("c1", 2, [echo(1, "hello world", "cmd-1")], "", "", true));
    r.applyFrame({ type: "thinking_delta", content: "thinking part one" });
    r.applyFrame({ type: "delta", content: "partial answer - **" });
    r.applyFrame({ type: "thinking_delta", content: "more thinking" });
    const committed = r.applyState(
      state(
        "c1",
        3,
        [
          echo(1, "hello world", "cmd-1"),
          row(2, {
            type: "assistant_message",
            turn: 1,
            step: 0,
            model: "m",
            usage,
            blocks: [
              { type: "reasoning" as const, text: "thinking part one more thinking" },
              { type: "text" as const, text: "full answer" },
            ],
          }),
        ],
        "",
        "",
        false,
      ),
    );
    expect(committed.blocks.map((b) => b.kind)).toEqual(["user", "reasoning", "text"]);
    expect(committed.blocks.every((b) => !b.key.startsWith("live-") && !b.key.startsWith("unpersisted-"))).toBe(true);
  });

  it("marks out-of-order states stale and changes nothing", () => {
    const r = createThreadReducer();
    r.open("c1");
    const first = r.applyState(state("c1", 5, [row(1, { type: "user_message", content: "go" })]));
    const stale = r.applyState(state("c1", 4, [], "late delta"));
    expect(stale.stale).toBe(true);
    expect(stale.blocks).toBe(first.blocks);
  });
});

describe("applyThreadEvents: live buffer supersession", () => {
  it("a mid-turn durable assistant_message replaces the streamed thinking buffer — no duplicate", () => {
    // Turn in flight: thinking streams as live frames, then the step's
    // assistant_message fans out through the journal lane. No ThreadState
    // publish comes mid-turn (the run-end flip is the turn's only view
    // broadcast), so the fan-out itself must retire the live buffer block —
    // otherwise the reasoning renders twice until a refresh re-derives.
    const r = createThreadReducer();
    r.open("c1");
    r.applyState(state("c1", 1, [row(1, { type: "user_message", content: "go" })]));
    r.applyFrame({ type: "thinking_delta", content: "thinking part one" });
    r.applyFrame({ type: "thinking_delta", content: " more thinking" });
    const fanned = r.applyThreadEvents("c1", 3, [
      row(2, {
        type: "assistant_message",
        turn: 1,
        step: 0,
        model: "m",
        usage,
        blocks: [
          { type: "reasoning" as const, text: "thinking part one more thinking" },
          { type: "tool_call" as const, id: "c9", name: "execute", arguments: "{}" },
        ],
      }),
    ]);
    const reasoning = fanned.blocks.filter((b) => b.kind === "reasoning");
    expect(reasoning).toHaveLength(1);
    expect(reasoning[0]!.reasoningText).toBe("thinking part one more thinking");
    expect(reasoning[0]!.key).toBe("2:0");
    expect(fanned.blocks.map((b) => b.key)).toEqual(["1:0", "2:0", "2:1"]);
  });

  it("a mid-turn durable assistant_message replaces the streamed text buffer — no duplicate", () => {
    const r = createThreadReducer();
    r.open("c1");
    r.applyState(state("c1", 1, [row(1, { type: "user_message", content: "go" })]));
    r.applyFrame({ type: "delta", content: "partial answer" });
    const fanned = r.applyThreadEvents("c1", 3, [
      row(2, {
        type: "assistant_message",
        turn: 1,
        step: 0,
        model: "m",
        usage,
        blocks: [{ type: "text" as const, text: "partial answer" }],
      }),
    ]);
    expect(fanned.blocks.map((b) => b.kind)).toEqual(["user", "text"]);
    expect(fanned.blocks.every((b) => !b.key.startsWith("live-") && !b.key.startsWith("unpersisted-"))).toBe(true);
  });

  it("a delta that reaches an unopened chat does not make its first sync stale", () => {
    // The owner's socket receives the fan-out of every chat that generates,
    // including a background child never opened. The delta creates a view;
    // the sync that follows must still build the full history.
    const r = createThreadReducer();
    const events = [
      row(1, { type: "user_message", content: "go" }),
      row(2, assistantText("first")),
      row(3, assistantText("second")),
    ];
    r.applyThreadEvents("child", 3, [events[2]!]);
    const synced = r.applyState(state("child", 3, events, "", "", false));
    expect(synced.stale).toBe(false);
    expect(synced.blocks.map((b) => b.kind)).toEqual(["user", "text", "text"]);
    expect(synced.blocks.map((b) => b.text)).toEqual(["go", "first", "second"]);
  });

  it("keeps delta rows newer than the sync window", () => {
    const r = createThreadReducer();
    const events = [
      row(1, { type: "user_message", content: "go" }),
      row(2, assistantText("first")),
      row(3, assistantText("second")),
    ];
    r.applyThreadEvents("child", 3, [events[2]!]);
    const synced = r.applyState(state("child", 2, events.slice(0, 2), "", "", false));
    expect(synced.blocks.map((b) => b.text)).toEqual(["go", "first", "second"]);
  });
});

describe("queued steering mode updates", () => {
  it("keeps one queued chip through promotion, then delivers that same message", () => {
    const reducer = createThreadReducer();
    reducer.open("chat");
    const queued: ThreadEventRow = {
      id: "same-message", seq: 1, created_at: "t",
      event: { type: "user_message", content: "correction", queued: true, mode: "queue" },
    };
    reducer.applyState(state("chat", 1, [queued]));
    const promoted: ThreadEventRow = {
      ...queued, seq: 2,
      event: { type: "user_message", content: "correction", queued: true, mode: "steer" },
    };
    const update = reducer.applyThreadEvents("chat", 2, [promoted]);
    expect(update.blocks.filter(block => block.kind === "user")).toHaveLength(1);
    expect(update.blocks[0]).toMatchObject({ eventId: "same-message", queued: true, queuedMode: "steer" });
    const delivered = reducer.applyThreadEvents("chat", 3, [{
      ...queued, seq: 3, event: { type: "user_message", content: "correction" },
    }]);
    expect(delivered.blocks.filter(block => block.kind === "user")).toHaveLength(1);
    expect(delivered.blocks[0]).toMatchObject({ eventId: "same-message" });
    expect(delivered.blocks[0]!.queued).toBeUndefined();
  });
});

describe("applyThreadEvents: incremental journal fan-out", () => {
  it("applies fresh rows live; a later sync with the same rows dedupes", () => {
    const r = createThreadReducer(); r.open("chat");
    const applied = r.applyThreadEvents("chat", 10, [
      row(9, assistantText("hi", 1)),
      row(8, { type: "user_message", content: "go" }),
    ]);
    expect(applied.blocks.map((b) => b.kind)).toEqual(["user", "text"]);
    // Rows at/below the watermark replay nothing.
    const again = r.applyThreadEvents("chat", 10, [row(9, assistantText("hi", 1))]);
    expect(again.blocks.map((b) => b.kind)).toEqual(["user", "text"]);
    // A full sync with the same log adds no duplicates.
    const synced = r.applyState(state("chat", 11, [
      row(8, { type: "user_message", content: "go" }),
      row(9, assistantText("hi", 1)),
    ], "", "", false));
    expect(synced.blocks.map((b) => b.kind)).toEqual(["user", "text"]);
  });

  it("never regresses the watermark", () => {
    const r = createThreadReducer(); r.open("chat");
    r.applyState(state("chat", 50, [row(10, { type: "user_message", content: "a" })]));
    r.applyThreadEvents("chat", 5, [row(4, { type: "user_message", content: "old" })]);
    // A stale thread_state with an older seq is still recognized as stale.
    expect(r.applyState(state("chat", 5, [])).stale).toBe(true);
  });

  it("tool_started provisions the row; the carrying message adopts it (no duplicate)", () => {
    const r = createThreadReducer(); r.open("chat");
    r.applyFrame({ type: "tool_started", call_id: "call-1", name: "hubspot_api", arguments: "{}", executor: "server" });
    expect(r.applyFrame({ type: "noop" } as never).blocks.map((b) => b.kind)).toEqual(["tool"]);
    // The durable assistant_message carrying the same call fans out a beat
    // later: adopt the provisioned block, don't push a second one.
    const applied = r.applyThreadEvents("chat", 12, [
      row(11, {
        type: "assistant_message",
        turn: 1,
        step: 0,
        model: "m",
        usage,
        blocks: [{ type: "tool_call", id: "call-1", name: "hubspot_api", arguments: "{}" } as never],
      }),
    ]);
    const toolBlocks = applied.blocks.filter((b) => b.kind === "tool");
    expect(toolBlocks).toHaveLength(1);
    expect((toolBlocks[0] as { tool: { args: string } }).tool.args).toBe("{}");
  });

  it("tool_completed can beat the anchor event's fan-out and still renders", () => {
    const r = createThreadReducer(); r.open("chat");
    const first = r.applyFrame({ type: "tool_completed", call_id: "call-9", name: "hubspot_api", content: "result", is_error: false });
    expect(first.blocks.filter((b) => b.kind === "tool")).toHaveLength(1);
    // The anchor adopts the provisioned row instead of duplicating it.
    const applied = r.applyThreadEvents("chat", 12, [
      row(11, {
        type: "assistant_message",
        turn: 1,
        step: 0,
        model: "m",
        usage,
        blocks: [{ type: "tool_call", id: "call-9", name: "hubspot_api", arguments: "{\"q\":1}" } as never],
      }),
    ]);
    const toolBlocks = applied.blocks.filter((b) => b.kind === "tool");
    expect(toolBlocks).toHaveLength(1);
    const tool = (toolBlocks[0] as { tool: { args: string; content?: string; status: string } }).tool;
    expect(tool.args).toBe("{\"q\":1}");
    expect(tool.content).toBe("result");
    expect(tool.status).toBe("done");
  });
});

describe("applyState: approval upsert mid-stream", () => {
  const request = row(2, { type: "approval_request", call_id: "c1", name: "execute", arguments: "{}" });

  it("renders the request card once across publishes (replay is an upsert)", () => {
    const r = createThreadReducer();
    r.open("c1");
    const first = r.applyState(state("c1", 2, [request]));
    expect(first.blocks.filter((b) => b.kind === "approval")).toHaveLength(1);
    // a later publish whose event list still contains the same request adds nothing
    const again = r.applyState(state("c1", 3, [request], "working"));
    expect(again.blocks.filter((b) => b.kind === "approval")).toHaveLength(1);
    expect(again.blocks.find((b) => b.kind === "approval")!.key).toBe("2:0");
  });

  it("an approved decision removes the card; an expired decision keeps it", () => {
    const r = createThreadReducer();
    r.open("c1");
    r.applyState(state("c1", 2, [request]));
    const approved = r.applyState(
      state("c1", 3, [request, row(3, { type: "approval_decision", call_id: "c1", approved: true })]),
    );
    expect(approved.blocks.filter((b) => b.kind === "approval")).toHaveLength(0);

    r.open(null);
    r.open("c2");
    r.applyState(state("c2", 2, [row(1, { type: "user_message", content: "go" }), request]));
    const expired = r.applyState(
      state(
        "c2",
        3,
        [
          row(1, { type: "user_message", content: "go" }),
          request,
          row(3, {
            type: "approval_decision",
            call_id: "c1",
            approved: false,
            reason: "no turn was waiting",
            expired: true,
          }),
        ],
        "",
        "",
        false,
      ),
    );
    const card = expired.blocks.find((b) => b.kind === "approval")!.approval!;
    expect(card.status).toBe("expired");
    expect(card.reason).toBe("no turn was waiting");
  });

  it("applyFrame upserts approval cards idempotently per call", () => {
    const r = createThreadReducer();
    r.open("c1");
    // The stream frame type is `approval_requested` (the persisted journal
    // event is `approval_request`).
    const first = r.applyFrame({ type: "approval_requested", call_id: "c1", name: "execute", arguments: "{}" });
    expect(first.blocks.filter((b) => b.kind === "approval")).toHaveLength(1);
    const again = r.applyFrame({ type: "approval_requested", call_id: "c1", name: "execute", arguments: "{}" });
    const cards = again.blocks.filter((b) => b.kind === "approval");
    expect(cards).toHaveLength(1);
    expect(cards[0].key).toBe("approval-c1");
    const resolved = r.applyFrame({ type: "approval_resolved", call_id: "c1", approved: true });
    expect(resolved.blocks.filter((b) => b.kind === "approval")).toHaveLength(0);
  });
});

describe("optimistic send vs server sync", () => {
  const pending = { chatId: "c1", text: "hello", key: "pending-1", sentAt: 123 };

  it("keeps the marker while the sync has no echo yet, settles on the durable echo", () => {
    const r = createThreadReducer();
    r.open("c1");
    r.optimisticSend(pending);
    expect(viewBlocks(r, "c1").some((b) => b.key === "pending-1" && b.pending)).toBe(true);
    // sync raced the HTTP request: no echo → the command stays visible
    const racing = r.applyState(state("c1", 2, [row(1, { type: "user_message", content: "earlier" })]));
    expect(racing.blocks.some((b) => b.key === "pending-1" && b.pending)).toBe(true);
    // the echo (row id == client message id) settles it
    const settled = r.applyState(
      state("c1", 3, [
        row(1, { type: "user_message", content: "earlier" }),
        echo(2, "hello", "pending-1"),
      ]),
    );
    expect(settled.blocks.some((b) => b.key === "pending-1")).toBe(false);
    expect(settled.blocks.filter((b) => b.kind === "user").map((b) => b.text)).toEqual([
      "earlier",
      "hello",
    ]);
  });

  it("another tab's echo does not settle this tab's marker (row id mismatch)", () => {
    const r = createThreadReducer();
    r.open("c1");
    r.optimisticSend(pending);
    const crossed = r.applyState(state("c1", 2, [row(1, { type: "user_message", content: "hello" })]));
    expect(crossed.blocks.some((b) => b.key === "pending-1" && b.pending)).toBe(true);
  });

  it("first send: the created chat adopts the scratch view and settles on its echo", () => {
    const r = createThreadReducer();
    r.open(null);
    const sent = r.optimisticSend({ chatId: null, text: "hello", key: "pending-9", sentAt: 1 });
    expect(sent.blocks.some((b) => b.key === "pending-9")).toBe(true);
    r.bindPending("new-chat", "pending-9");
    const adopted = r.adopt("new-chat");
    expect(adopted.blocks.some((b) => b.key === "pending-9")).toBe(true);
    const settled = r.applyState(state("new-chat", 2, [echo(1, "hello", "pending-9")]));
    expect(settled.blocks.some((b) => b.key === "pending-9")).toBe(false);
    expect(settled.blocks.filter((b) => b.kind === "user").map((b) => b.text)).toEqual(["hello"]);
  });

  it("failSend removes the optimistic block, appends the error, releases the marker", () => {
    const r = createThreadReducer();
    r.open("c1");
    r.optimisticSend(pending);
    const failed = r.failSend("c1", "pending-1", "network down");
    expect(failed.blocks.some((b) => b.key === "pending-1")).toBe(false);
    const err = failed.blocks.find((b) => b.kind === "error");
    expect(err?.text).toBe("network down");
    // marker released: a later sync without an echo re-appends nothing
    const later = r.applyState(state("c1", 2, [row(1, { type: "user_message", content: "old" })]));
    expect(later.blocks.some((b) => b.pending)).toBe(false);
  });

  it("matches the shipped reconcilePendingSend + threadStateBlocks merge", () => {
    const r = createThreadReducer();
    r.open("c1");
    r.optimisticSend(pending);
    const rows = [echo(1, "hello", "pending-1")];
    const settled = r.applyState(state("c1", 1, rows, "", "", false));
    const pendingSend = { ...pending };
    expect(settled.blocks).toEqual(
      reconcilePendingSend(rows, threadStateBlocks({ ...state("c1", 1, rows, "", "", false) }), pendingSend),
    );
  });
});

describe("compacting guard (the null === null flash)", () => {
  it("shows the line only for the compaction's chat — never on a null chatId", () => {
    const r = createThreadReducer();
    r.open("c1");
    r.applyState(state("c1", 1, [row(1, { type: "user_message", content: "go" })], "", "", true));
    expect(r.setCompacting("c1").compacting).toBe(true);
    // navigation to the new-chat view while armed: no line (null !== "c1")
    expect(r.open(null).compacting).toBe(false);
    expect(r.open("c1").compacting).toBe(true);
  });

  it("a new compaction event settles the pending line", () => {
    const r = createThreadReducer();
    r.open("c1");
    r.applyState(state("c1", 1, [row(1, { type: "user_message", content: "go" })]));
    r.setCompacting("c1");
    // busy while the summarization runs: line stays
    expect(r.applyState(state("c1", 2, [], "", "summarizing", true)).compacting).toBe(true);
    // the compaction event lands: line clears, card renders
    const done = r.applyState(
      state(
        "c1",
        3,
        [row(1, { type: "user_message", content: "go" }), row(2, { type: "compaction", summary: "so far: go" })],
        "",
        "",
        false,
      ),
    );
    expect(done.compacting).toBe(false);
    expect(done.blocks.find((b) => b.kind === "compaction")!.compaction!.summary).toBe("so far: go");
  });

  it("a no-op task outcome clears the line without depending on generation state", () => {
    const r = createThreadReducer();
    r.open("c1");
    r.applyState(state("c1", 1, [row(1, { type: "user_message", content: "go" })]));
    r.setCompacting("c1");
    r.applyState(state("c1", 2, [], "", "thinking", true));
    const ended = r.applyState(state("c1", 3, [], "", "", false));
    expect(ended.compacting).toBe(true);
    expect(ended.blocks.some((b) => b.kind === "compaction")).toBe(false);
    expect(r.finishCompacting("c1").compacting).toBe(false);
  });

  it("another chat's completed compaction cannot clear the current pending task", () => {
    const r = createThreadReducer();
    r.open("c1");
    r.setCompacting("c1");
    r.open("c2");
    r.setCompacting("c2");
    expect(r.finishCompacting("c1").compacting).toBe(true);
    expect(r.finishCompacting("c2").compacting).toBe(false);
  });

  it("compaction keys already present when /compact was sent do not settle it", () => {
    const r = createThreadReducer();
    r.open("c1");
    const history = [
      row(1, { type: "user_message", content: "go" }),
      row(2, { type: "compaction", summary: "old" }),
    ];
    r.applyState(state("c1", 2, history));
    r.setCompacting("c1");
    // the same sync re-delivered: no NEW key → still compacting
    expect(r.applyState(state("c1", 2, history)).compacting).toBe(true);
    expect(r.applyState(state("c1", 3, [...history], "", "new summary", true)).compacting).toBe(true);
  });
});

describe("artifact card on spilled tool_result frames", () => {
  const callEvent = {
    type: "assistant_message" as const,
    turn: 1,
    step: 1,
    model: "m",
    usage,
    blocks: [{ type: "tool_call" as const, id: "c9", name: "api", arguments: "{}" }],
  };
  const spilled = {
    type: "tool_result" as const,
    turn: 1,
    step: 1,
    call_id: "c9",
    name: "api",
    content: "full result at .guild/artifacts/chat-1/report.xlsx",
    is_error: false,
    artifact_id: "11111111-1111-1111-1111-111111111111",
    meta: artifactMeta,
  };

  it("joins the result onto its call across publishes; the card is reachable", () => {
    const r = createThreadReducer();
    r.open("c1");
    r.applyState(state("c1", 2, [row(1, { type: "user_message", content: "go" }), row(2, callEvent)]));
    const all = [row(1, { type: "user_message", content: "go" }), row(2, callEvent), row(3, spilled)];
    const filled = r.applyState(state("c1", 3, all));
    expect(filled.blocks).toHaveLength(2);
    const card = artifactCardOf(filled.blocks[1].tool!);
    expect(card?.filename).toBe("report.xlsx");
    expect(card?.size_bytes).toBe(14821);
    expect(filled.blocks).toEqual(eventsToBlocks(all));
  });

  it("renders the spilled frame even when the call block never arrived", () => {
    const r = createThreadReducer();
    r.open("c1");
    r.applyState(state("c1", 1, []));
    const orphan = r.applyState(state("c1", 2, [row(2, spilled)]));
    expect(orphan.blocks).toHaveLength(1);
    expect(orphan.blocks[0].tool!.status).toBe("done");
    expect(artifactCardOf(orphan.blocks[0].tool!)?.filename).toBe("report.xlsx");
  });

  it("renders the server's flat card shape (spill::artifact_meta output)", () => {
    expect(artifactCardOf({ meta: artifactMetaFlat })?.filename).toBe("report.xlsx");
    expect(artifactCardOf({ meta: artifactMetaFlat })?.id).toBe(
      "11111111-1111-1111-1111-111111111111",
    );
    // A nested card still renders (compatibility).
    expect(artifactCardOf({ meta: artifactMeta })?.filename).toBe("report.xlsx");
    // Non-artifact meta still narrows to null.
    expect(artifactCardOf({ meta: { card: "api", status: 200 } })).toBeNull();
  });
});

describe("open / adopt / cache", () => {
  it("caches the previous chat's blocks and restores them on switch-back", () => {
    const r = createThreadReducer();
    r.open("a");
    r.applyState(state("a", 1, [row(1, { type: "user_message", content: "hi" })]));
    const toB = r.open("b");
    expect(toB.blocks).toEqual([]);
    expect(toB.restored).toBe(false);
    const back = r.open("a");
    expect(back.restored).toBe(true);
    expect(back.blocks.map((b) => b.text)).toEqual(["hi"]);
  });

  it("a never-cached chat reports not-restored; an empty thread re-derives", () => {
    const r = createThreadReducer();
    const none = r.open(null);
    expect(none.blocks).toEqual([]);
    expect(none.restored).toBe(false);
    r.open("a");
    r.applyState(state("a", 1, []));
    expect(r.open("b").restored).toBe(false);
  });

  it("invalidate forces a full re-derive on the next state", () => {
    const r = createThreadReducer();
    r.open("a");
    const events = [row(1, { type: "user_message", content: "go" }), row(2, assistantText("hi"))];
    r.applyState(state("a", 2, events));
    r.invalidate();
    const again = r.applyState(state("a", 2, events, "", "", false));
    expect(again.stale).toBe(false);
    expect(again.blocks).toEqual(eventsToBlocks(events));
  });

  it("settleAttachment swaps the uploaded id (dropping the preview) or only the preview", () => {
    const r = createThreadReducer();
    r.open("a");
    r.optimisticSend({
      chatId: "a",
      text: "see this",
      key: "k1",
      sentAt: 0,
      attachments: [
        { id: "pending-x", filename: "pic.png", content_type: "image/png", size_bytes: 5, modality: "image", previewUrl: "blob:x" },
        { id: "pending-y", filename: "doc.pdf", content_type: "application/pdf", size_bytes: 5, modality: "document" },
      ],
    });
    const swapped = r.settleAttachment("k1", "pending-x", "att-1");
    const atts = swapped.blocks[0].attachments!;
    expect(atts[0].id).toBe("att-1");
    expect(atts[0].previewUrl).toBeUndefined();
    const cleared = r.settleAttachment("k1", "pending-y");
    expect(cleared.blocks[0].attachments![1].id).toBe("pending-y");
    expect(cleared.blocks[0].attachments![1].previewUrl).toBeUndefined();
  });
});

// -- helpers ---------------------------------------------------------------

/** Reads a chat's current blocks through a stale-state probe (no mutation). */
function viewBlocks(r: ReturnType<typeof createThreadReducer>, chatId: string) {
  return r.open(chatId).blocks;
}

it("retains every queued optimistic command across authoritative rebuilds", () => {
  const r = createThreadReducer(); r.open("chat");
  r.optimisticSend({ chatId: "chat", text: "one", key: "id-1", sentAt: 1 });
  r.optimisticSend({ chatId: "chat", text: "two", key: "id-2", sentAt: 2 });
  expect(r.applyState(state("chat", 1, [])).blocks.filter(b => b.pending).map(b => b.text)).toEqual(["one", "two"]);
  r.invalidate();
  const rebuilt = r.applyState(state("chat", 2, [echo(1, "one", "id-1")]));
  expect(rebuilt.blocks.filter(b => b.kind === "user").map(b => b.text)).toEqual(["one", "two"]);
  expect(rebuilt.blocks.filter(b => b.pending).map(b => b.text)).toEqual(["two"]);
  expect(r.applyState(state("chat", 3, [echo(1, "one", "id-1"), echo(2, "two", "id-2")])).blocks.filter(b => b.pending)).toEqual([]);
});

it("a create-time failure is owned by scratch and cannot reappear on later adoption", () => {
  const r = createThreadReducer(); r.open(null);
  r.optimisticSend({ chatId: null, text: "first", key: "first", sentAt: 1 });
  r.bindPending("created", "first");
  r.failSend("created", "first", "upload failed");
  const adopted = r.adopt("created");
  expect(adopted.blocks.some(b => b.pending)).toBe(false);
  expect(adopted.blocks.some(b => b.kind === "error")).toBe(true);
});

describe("provider error surfacing (tracked on assistant_message, shown only while latest)", () => {
  const assistantError = (error: string, step = 0): ThreadEvent => ({
    type: "assistant_message",
    turn: 1,
    step,
    model: "m",
    usage,
    blocks: [],
    error,
  });

  it("derivation shows the error when it is the thread's latest block", () => {
    const blocks = eventsToBlocks([
      row(1, { type: "user_message", content: "hello" }),
      row(2, assistantError("502: provider auth failed")),
    ]);
    expect(blocks.filter(b => b.kind === "error").map(b => b.text)).toEqual(["502: provider auth failed"]);
  });

  it("a later retry's content supersedes the earlier error", () => {
    const blocks = eventsToBlocks([
      row(1, { type: "user_message", content: "hello" }),
      row(2, assistantError("502: transient")),
      row(3, assistantText("hi there")),
    ]);
    expect(blocks.filter(b => b.kind === "error")).toEqual([]);
    expect(blocks.filter(b => b.kind === "text").map(b => b.text)).toEqual(["hi there"]);
  });

  it("only the latest of several failed attempts renders", () => {
    const blocks = eventsToBlocks([
      row(1, { type: "user_message", content: "hello" }),
      row(2, assistantError("502: attempt one")),
      row(3, assistantError("502: attempt two (final)")),
    ]);
    expect(blocks.filter(b => b.kind === "error").map(b => b.text)).toEqual(["502: attempt two (final)"]);
  });

  it("an error from a finished turn is pruned once a new turn produces content", () => {
    const r = createThreadReducer(); r.open("chat");
    r.applyThreadEvents("chat", 0, [
      row(1, { type: "user_message", content: "hello" }),
      row(2, assistantError("502: provider auth failed")),
    ]);
    expect(r.applyThreadEvents("chat", 0, []).blocks.some(b => b.kind === "error")).toBe(true);
    const after = r.applyThreadEvents("chat", 0, [
      row(3, { type: "user_message", content: "try again" }),
      row(4, assistantText("works now", 1)),
    ]);
    expect(after.blocks.some(b => b.kind === "error")).toBe(false);
  });

  it("an error is pruned once a newer user message lands, even before its answer", () => {
    const r = createThreadReducer(); r.open("chat");
    r.applyThreadEvents("chat", 0, [
      row(1, { type: "user_message", content: "hello" }),
      row(2, assistantError("502: provider auth failed")),
      row(3, { type: "user_message", content: "queued retry" }),
    ]);
    expect(r.applyThreadEvents("chat", 0, []).blocks.some(b => b.kind === "error")).toBe(false);
  });
});

describe("older-page loading (bounded tail + prepend)", () => {
  const user = (seq: number, content: string) =>
    row(seq, { type: "user_message", content });

  it("a tail state reports has_more and the oldest loaded seq", () => {
    const r = createThreadReducer();
    r.open("chat");
    const applied = r.applyState({ ...state("chat", 100, [user(51, "a"), user(52, "b")]), has_more_events: true });
    expect(applied.hasMore).toBe(true);
    expect(applied.oldestSeq).toBe(51);
    expect(applied.blocks.filter(b => b.kind === "user").map(b => b.text)).toEqual(["a", "b"]);
  });

  it("prepending an older page keeps the reader's content and re-derives in order", () => {
    const r = createThreadReducer();
    r.open("chat");
    r.applyState({ ...state("chat", 100, [user(51, "a"), user(52, "b")]), has_more_events: true });

    const older = r.prependEvents("chat", [user(49, "old-1"), user(50, "old-2")], false);
    expect(older.oldestSeq).toBe(49);
    expect(older.hasMore).toBe(false);
    expect(older.blocks.filter(b => b.kind === "user").map(b => b.text)).toEqual([
      "old-1", "old-2", "a", "b",
    ]);
  });

  it("prepended rows join their cross-page tool result and keep the live buffers", () => {
    const r = createThreadReducer();
    r.open("chat");
    r.applyState({ ...state("chat", 100, [user(51, "a")]), has_more_events: true });
    // A live frame provisions a tool block with no durable row yet.
    r.applyFrame({
      type: "tool_started",
      call_id: "call-1",
      name: "bash",
      arguments: "{}",
      executor: "server",
    });

    const older = r.prependEvents("chat", [
      row(40, assistantText("step", 0)),
      row(41, { type: "tool_result", turn: 1, step: 0, call_id: "call-1", name: "bash", content: "ok", is_error: false }),
    ], false);
    const tools = older.blocks.filter(b => b.kind === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0]!.tool?.content).toBe("ok");
    expect(older.blocks.filter(b => b.kind === "text").map(b => b.text)).toEqual(["step"]);
  });

  it("a reconnect re-derives from the state's tail window", () => {
    const r = createThreadReducer();
    r.open("chat");
    r.applyState({ ...state("chat", 100, [user(51, "a"), user(52, "b")]), has_more_events: true });
    r.prependEvents("chat", [user(49, "old-1"), user(50, "old-2")], false);

    r.invalidate();
    const after = r.applyState({ ...state("chat", 101, [user(51, "a"), user(52, "b")]), has_more_events: true });
    expect(after.oldestSeq).toBe(51);
    expect(after.hasMore).toBe(true);
    expect(after.blocks.filter(b => b.kind === "user").map(b => b.text)).toEqual(["a", "b"]);
  });

  it("incremental fan-out rows append to the loaded window", () => {
    const r = createThreadReducer();
    r.open("chat");
    r.applyState({ ...state("chat", 100, [user(51, "a")]), has_more_events: true });
    r.prependEvents("chat", [user(49, "old")], false);
    const after = r.applyThreadEvents("chat", 102, [user(53, "new")]);
    expect(after.blocks.filter(b => b.kind === "user").map(b => b.text)).toEqual(["old", "a", "new"]);
    expect(after.hasMore).toBe(false);
  });
});

describe("subagent records (child events)", () => {
  const spawned = (over: Partial<Extract<ThreadEvent, { type: "child_spawned" }>> = {}): ThreadEvent => ({
    type: "child_spawned",
    thread_id: "child-thread",
    run_id: "child-run",
    chat_id: "child-chat",
    agent_name: "Researcher",
    title: "market scan",
    task: "",
    status: "running",
    ...over,
  });
  const result = (over: Partial<Extract<ThreadEvent, { type: "child_result" }>> = {}): ThreadEvent => ({
    type: "child_result",
    thread_id: "child-thread",
    run_id: "child-run",
    status: "succeeded",
    final_text: "done",
    ...over,
  });
  const closed = (over: Partial<Extract<ThreadEvent, { type: "child_closed" }>> = {}): ThreadEvent => ({
    type: "child_closed",
    thread_id: "child-thread",
    ...over,
  });
  const rowAt = (seq: number, event: ThreadEvent, at: string): ThreadEventRow => ({
    id: `e${seq}`,
    seq,
    event,
    created_at: at,
  });

  it("renders a spawn as its own record with the request", () => {
    const derived = deriveThread([
      rowAt(1, spawned({ task: "scan the market" }), "2026-10-22T10:00:00.000Z"),
    ]);
    const records = derived.blocks.filter((b) => b.kind === "child_spawn");
    expect(records).toHaveLength(1);
    expect(records[0]!.key).toBe("1:0");
    expect(records[0]!.childSpawn).toEqual({
      threadId: "child-thread",
      chatId: "child-chat",
      agentName: "Researcher",
      title: "market scan",
      task: "scan the market",
      startedAt: "2026-10-22T10:00:00.000Z",
    });
  });

  it("renders a result as its own record, not merged into the spawn", () => {
    const derived = deriveThread([
      rowAt(1, spawned({ task: "scan the market" }), "2026-10-22T10:00:00.000Z"),
      rowAt(2, result({ final_text: "found three" }), "2026-10-22T10:00:10.000Z"),
    ]);
    expect(derived.blocks.filter((b) => b.kind === "child_spawn")).toHaveLength(1);
    const results = derived.blocks.filter((b) => b.kind === "child_result");
    expect(results).toHaveLength(1);
    expect(results[0]!.key).toBe("2:0");
    expect(results[0]!.childResult).toMatchObject({
      threadId: "child-thread",
      chatId: "child-chat",
      agentName: "Researcher",
      title: "market scan",
      status: "succeeded",
      finalText: "found three",
      finishedAt: "2026-10-22T10:00:10.000Z",
    });
  });

  it("keeps a result that has no loaded spawn", () => {
    const derived = deriveThread([
      rowAt(9, result({ status: "cancelled", chat_id: "child-chat", started_at: "2026-10-22T09:59:00.000Z" }), "2026-10-22T10:00:00.000Z"),
    ]);
    const records = derived.blocks.filter((b) => b.kind === "child_result");
    expect(records).toHaveLength(1);
    expect(records[0]!.childResult).toMatchObject({
      threadId: "child-thread",
      chatId: "child-chat",
      status: "cancelled",
      startedAt: "2026-10-22T09:59:00.000Z",
      finishedAt: "2026-10-22T10:00:00.000Z",
    });
  });

  it("labels a close from the spawn already in the transcript", () => {
    const derived = deriveThread([
      rowAt(1, spawned(), "2026-10-22T10:00:00.000Z"),
      rowAt(2, closed(), "2026-10-22T10:00:10.000Z"),
    ]);
    const records = derived.blocks.filter((b) => b.kind === "child_closed");
    expect(records).toHaveLength(1);
    expect(records[0]!.childClosed).toEqual({
      threadId: "child-thread",
      chatId: "child-chat",
      agentName: "Researcher",
      title: "market scan",
    });
  });

  it("keeps two children as four separate records", () => {
    const derived = deriveThread([
      row(1, spawned({ thread_id: "child-1", chat_id: "chat-1", title: "first" })),
      row(2, spawned({ thread_id: "child-2", chat_id: "chat-2", title: "second" })),
      row(3, result({ thread_id: "child-1", chat_id: "chat-1", title: "first" })),
    ]);
    expect(derived.blocks.filter((b) => b.kind === "child_spawn").map((b) => b.key)).toEqual(["1:0", "2:0"]);
    expect(derived.blocks.filter((b) => b.kind === "child_result").map((b) => b.key)).toEqual(["3:0"]);
  });

  it("keeps the spawn and result order through the incremental lane", () => {
    const r = createThreadReducer();
    r.open("chat");
    r.applyState(state("chat", 1, [rowAt(1, spawned({ task: "scan the market" }), "2026-10-22T10:00:00.000Z")]));
    const applied = r.applyThreadEvents("chat", 2, [
      rowAt(2, result({ final_text: "found three" }), "2026-10-22T10:00:10.000Z"),
    ]);
    expect(applied.blocks.map((b) => b.kind).filter((k) => k.startsWith("child"))).toEqual([
      "child_spawn",
      "child_result",
    ]);
    expect(applied.blocks[1]!.childResult).toMatchObject({ finalText: "found three" });
  });
});

describe("open cache reports synced, not non-empty", () => {
  it("a previously synced empty thread swaps without a skeleton", () => {
    const r = createThreadReducer();
    r.open("empty");
    r.applyState(state("empty", 1, []));
    expect(r.open("other").restored).toBe(false);
    const back = r.open("empty");
    expect(back.restored).toBe(true);
    expect(back.synced).toBe(true);
    expect(back.blocks).toEqual([]);
  });
});

describe("live tool frames keep the React state contract", () => {
  it("tool_started and tool_completed replace the tool object and the block array", () => {
    const r = createThreadReducer();
    r.open("chat");
    const started = r.applyFrame({
      type: "tool_started",
      call_id: "call-1",
      name: "bash",
      arguments: "{}",
      executor: "server",
    });
    const startedBlock = started.blocks[0];
    expect(startedBlock.kind).toBe("tool");
    const startedTool = startedBlock.kind === "tool" ? startedBlock.tool! : null;
    expect(startedTool?.status).toBe("running");

    const again = r.applyFrame({
      type: "tool_started",
      call_id: "call-1",
      name: "bash",
      arguments: "{}",
      executor: "server",
    });
    expect(again.blocks).not.toBe(started.blocks);
    expect(again.blocks[0]).not.toBe(startedBlock);
    const againTool = again.blocks[0].kind === "tool" ? again.blocks[0].tool! : null;
    expect(againTool).not.toBe(startedTool);
    expect(startedTool?.status).toBe("running");

    const completed = r.applyFrame({
      type: "tool_completed",
      call_id: "call-1",
      name: "bash",
      content: "ok",
      is_error: false,
    });
    expect(completed.blocks).not.toBe(again.blocks);
    const completedTool = completed.blocks[0].kind === "tool" ? completed.blocks[0].tool! : null;
    expect(completedTool).not.toBe(againTool);
    expect(completedTool?.status).toBe("done");
    expect(againTool?.status).toBe("running");
  });
});
