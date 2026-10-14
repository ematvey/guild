// Thread-reducer tests. Each transition class is seeded from the shipped
// bug it guards against (PLAN-suggestions §7a): replay-during-generating,
// approval upsert mid-stream, optimistic-vs-sync, compacting guard
// (null === null), artifact card on spilled tool_result frames.

import { describe, expect, it } from "vitest";
import {
  artifactCardOf,
  createThreadReducer,
  eventsToBlocks,
  reconcilePendingSend,
  threadStateBlocks,
} from "./thread-reducer";
import type { ThreadEvent, ThreadEventRow, ThreadState } from "../transport";

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

  it("a new compaction event is the success signal; busy→false without one is failure", () => {
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

  it("busy→false with no compaction event clears the line (nothing was appended)", () => {
    const r = createThreadReducer();
    r.open("c1");
    r.applyState(state("c1", 1, [row(1, { type: "user_message", content: "go" })]));
    r.setCompacting("c1");
    r.applyState(state("c1", 2, [], "", "thinking", true));
    const ended = r.applyState(state("c1", 3, [], "", "", false));
    expect(ended.compacting).toBe(false);
    expect(ended.blocks.some((b) => b.kind === "compaction")).toBe(false);
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
