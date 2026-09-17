// Pure-logic tests for WebChat's highest-risk functions (no DOM, no server).
// These run under `npm test` (vitest); see package.json.

import { describe, expect, it } from "vitest";
import {
  chatRoutePath,
  compareVersions,
  eventsToBlocks,
  parseChatRoute,
  parseSearchResults,
  reconcilePendingSend,
  threadStateBlocks,
  statusFromThreads,
  offlineMachine,
  replayFrom,
  resolveApproval,
  toolLabel,
  toolDisplayName,
  upsertApproval,
  accountDefaultLabel,
  type Block,
} from "./WebChat";
import type { ApprovalPolicy, ThreadEvent, ThreadEventRow } from "../transport";

function row(seq: number, event: ThreadEvent): ThreadEventRow {
  return { id: `e${seq}`, seq, event, created_at: "t" };
}

const usage = { tokens_in: 0, tokens_out: 0, cost_usd: 0 };

describe("parseChatRoute / chatRoutePath", () => {
  const roundTrip = (path: string) =>
    chatRoutePath(
      parseChatRoute(path).chatId,
      parseChatRoute(path).projectId,
      parseChatRoute(path).overlay,
    );

  it("round-trips every route shape", () => {
    for (const path of [
      "/",
      "/thread/abc-123",
      "/thread/abc-123/device",
      "/project/p1",
      "/project/p1/thread/abc-123",
      "/device",
      "/settings",
      "/settings/models",
      "/settings/integrations/my-slug",
    ]) {
      expect(roundTrip(path)).toBe(path);
    }
  });

  it("parses thread + overlay combinations", () => {
    expect(parseChatRoute("/thread/x")).toEqual({ chatId: "x", projectId: null, overlay: null });
    expect(parseChatRoute("/thread/x/device")).toEqual({
      chatId: "x",
      projectId: null,
      overlay: { kind: "device" },
    });
    expect(parseChatRoute("/settings/integrations/a/b")).toEqual({
      chatId: null,
      projectId: null,
      overlay: { kind: "settings", section: "integrations", detail: "a/b" },
    });
    // trailing slashes and empty segments are ignored
    expect(parseChatRoute("/thread/x/")).toEqual({ chatId: "x", projectId: null, overlay: null });
    expect(parseChatRoute("")).toEqual({ chatId: null, projectId: null, overlay: null });
    // a detail carrying an encoded slash parses to the full id and the
    // rebuilt path is parse-stable from there on
    const once = chatRoutePath(
      parseChatRoute("/settings/integrations/my%2Fslug").chatId,
      parseChatRoute("/settings/integrations/my%2Fslug").projectId,
      parseChatRoute("/settings/integrations/my%2Fslug").overlay,
    );
    expect(parseChatRoute(once).overlay).toEqual({
      kind: "settings",
      section: "integrations",
      detail: "my/slug",
    });
  });

  it("parses the project filter, with and without an open thread", () => {
    expect(parseChatRoute("/project/p1")).toEqual({ chatId: null, projectId: "p1", overlay: null });
    expect(parseChatRoute("/project/p1/thread/c1")).toEqual({
      chatId: "c1",
      projectId: "p1",
      overlay: null,
    });
    // a bare /thread/<id> has no project filter (deep link)
    expect(parseChatRoute("/thread/c1").projectId).toBeNull();
    // /project without an id is not a project route
    expect(parseChatRoute("/project")).toEqual({ chatId: null, projectId: null, overlay: null });
  });
});

describe("eventsToBlocks", () => {
  it("replays assistant blocks in stream order and joins tool results", () => {
    const blocks = eventsToBlocks([
      row(2, {
        type: "assistant_message",
        turn: 1,
        step: 1,
        model: "m",
        usage,
        blocks: [
          { type: "text", text: "let me look" },
          { type: "tool_call", id: "c1", name: "read_file", arguments: JSON.stringify({ path: "a" }) },
        ],
      }),
      row(1, { type: "user_message", content: "read a" }),
      row(3, {
        type: "tool_result",
        turn: 1,
        step: 1,
        call_id: "c1",
        name: "read_file",
        content: "contents",
        is_error: false,
      }),
    ]);
    // rows are sorted by seq regardless of input order
    expect(blocks.map((b) => b.kind)).toEqual(["user", "text", "tool"]);
    const tool = blocks[2].tool!;
    expect(tool.callId).toBe("c1");
    expect(tool.status).toBe("done");
    expect(tool.content).toBe("contents");
    // stable keys derived from the source event's seq
    expect(blocks.map((b) => b.key)).toEqual(["1:0", "2:0", "2:1"]);
  });

  it("labels integration tools natively via the tool kind", () => {
    const blocks = eventsToBlocks([
      row(1, {
        type: "tool_result",
        turn: 1,
        step: 1,
        call_id: "c1",
        name: "firecrawl_search",
        content: "results",
        is_error: false,
        kind: "web_search",
      } as ThreadEvent),
      row(2, {
        type: "tool_result",
        turn: 1,
        step: 2,
        call_id: "c2",
        name: "firecrawl_scrape",
        content: "page",
        is_error: false,
        kind: "web_browse",
      } as ThreadEvent),
      row(3, {
        type: "tool_result",
        turn: 1,
        step: 3,
        call_id: "c3",
        name: "int_searxng_web_search",
        content: "legacy name, meta kind only",
        is_error: false,
        meta: { card: "web", kind: "search", sources: [] },
      } as ThreadEvent),
    ]);
    expect(toolLabel(blocks[0].tool!)).toBe("Web search");
    expect(toolLabel(blocks[1].tool!)).toBe("Browse");
    // legacy pre-kind events fall back to the widget meta kind
    expect(toolLabel(blocks[2].tool!)).toBe("Web search");
  });

  it("keeps the connector slug in tool labels", () => {
    expect(toolDisplayName("atlassian_api")).toBe("atlassian api");
    expect(toolDisplayName("gitlab_api")).toBe("gitlab api");
    expect(toolDisplayName("int_github_api")).toBe("github api");
    expect(toolDisplayName("atlassian_jira_search")).toBe("atlassian jira search");
    // no namespace: bare name stands alone
    expect(toolDisplayName("api")).toBe("api");
  });

  it("renders an orphan tool_result instead of dropping it", () => {
    const blocks = eventsToBlocks([
      row(1, {
        type: "tool_result",
        turn: 1,
        step: 1,
        call_id: "ghost",
        name: "execute",
        content: "out",
        is_error: true,
      }),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].tool!.status).toBe("error");
    expect(blocks[0].tool!.name).toBe("execute");
  });

  it("carries compaction cards at their event position", () => {
    const blocks = eventsToBlocks([
      row(1, { type: "user_message", content: "hi" }),
      row(2, { type: "compaction", summary: "so far: hi" }),
      row(3, { type: "user_message", content: "more" }),
    ]);
    expect(blocks.map((b) => b.kind)).toEqual(["user", "compaction", "user"]);
    expect(blocks[1].compaction!.summary).toBe("so far: hi");
  });
});

describe("accountDefaultLabel (unset chat trigger label)", () => {
  it("maps the account default onto the matching mode; unset = approve for me", () => {
    expect(accountDefaultLabel(null)).toBe("Approve for me");
    expect(accountDefaultLabel({} as ApprovalPolicy)).toBe("Approve for me");
    expect(accountDefaultLabel({ default: "ask" } as ApprovalPolicy)).toBe("Ask for approval");
    expect(accountDefaultLabel({ default: "allow" } as ApprovalPolicy)).toBe("Full access");
    expect(accountDefaultLabel({ default: "never" } as ApprovalPolicy)).toBe("Deny all");
  });
});

describe("approval upsert/resolve", () => {
  const card = (callId: string) => ({
    callId,
    name: "execute",
    args: "{}",
    status: "pending" as const,
  });

  it("upsert is idempotent per call", () => {
    let blocks: Block[] = [];
    blocks = upsertApproval(blocks, card("c1"));
    blocks = upsertApproval(blocks, card("c1"));
    blocks = upsertApproval(blocks, card("c2"));
    expect(blocks).toHaveLength(2);
    // the existing card's stable key survives the upsert
    expect(blocks[0].key).toBe("approval-c1");
  });

  it("resolve removes the matching card entirely", () => {
    let blocks: Block[] = [upsertApproval([], card("c1"))[0], upsertApproval([], card("c2"))[0]];
    blocks = resolveApproval(blocks, "c1", false, "no");
    // a decided approval is not conversation content — the card is gone;
    // the denial story lives on in the tool-result frame
    expect(blocks).toHaveLength(1);
    expect(blocks[0].approval!.callId).toBe("c2");
    // unknown call: no-op
    expect(resolveApproval(blocks, "other", true)).toEqual(blocks);
  });

  it("history derivation drops resolved approvals, keeps pending", () => {
    const blocks = eventsToBlocks([
      row(0, { type: "user_message", content: "go" }),
      row(1, { type: "approval_request", call_id: "c1", name: "execute", arguments: "{}" }),
      row(2, { type: "approval_decision", call_id: "c1", approved: true, reason: null }),
      row(3, { type: "approval_request", call_id: "c2", name: "execute", arguments: "{}" }),
      row(4, { type: "assistant_message", turn: 1, step: 0, blocks: [], usage, model: "m", interrupted: null }),
    ]);
    const approvals = blocks.filter((b) => b.kind === "approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0].approval!.callId).toBe("c2");
    expect(approvals[0].approval!.status).toBe("pending");
  });

  it("history derivation keeps expired approvals — no tool result tells their story", () => {
    const blocks = eventsToBlocks([
      row(0, { type: "user_message", content: "go" }),
      row(1, { type: "approval_request", call_id: "c1", name: "execute", arguments: "{}" }),
      row(2, {
        type: "approval_decision",
        call_id: "c1",
        approved: false,
        reason: "expired — no turn was waiting for this approval",
        expired: true,
      }),
    ]);
    const approvals = blocks.filter((b) => b.kind === "approval");
    expect(approvals).toHaveLength(1);
    expect(approvals[0].approval!.status).toBe("expired");
  });

  it("interrupted assistant events mark the last text block, not earlier ones", () => {
    const blocks = eventsToBlocks([
      row(0, { type: "user_message", content: "write a long essay" }),
      row(1, {
        type: "assistant_message",
        turn: 1,
        step: 0,
        model: "m",
        usage,
        interrupted: true,
        blocks: [
          { type: "reasoning", text: "thinking…" },
          { type: "text", text: "partial answer so far" },
        ],
      }),
    ]);
    expect(blocks.filter((b) => b.kind === "text")).toHaveLength(1);
    expect(blocks.find((b) => b.kind === "text")!.interrupted).toBe(true);
    expect(blocks.find((b) => b.kind === "reasoning")!.interrupted).toBeUndefined();
  });

  it("a completed turn carries no interrupted marker", () => {
    const blocks = eventsToBlocks([
      row(0, {
        type: "assistant_message",
        turn: 1,
        step: 0,
        model: "m",
        usage,
        interrupted: null,
        blocks: [{ type: "text", text: "done" }],
      }),
    ]);
    expect(blocks.find((b) => b.kind === "text")!.interrupted).toBeUndefined();
  });
});

describe("authoritative socket state", () => {
  it("overwrites reflected tokens instead of appending them during sync", () => {
    const state = { chat_id: "chat-1", seq: 2, events: [], text: "hello", thinking: "", generating: true };
    expect(threadStateBlocks(state).filter(b => b.kind === "text").map(b => b.text)).toEqual(["hello"]);
    expect(threadStateBlocks({ ...state, seq: 3, text: "hello!" }).map(b => b.text)).toEqual(["hello!"]);
  });
  it("renders a cross-tab user echo with no optimistic local send", () => {
    const state = { chat_id: "chat-1", seq: 3, events: [row(1, { type: "user_message", content: "other tab" })], text: "", thinking: "", generating: true };
    expect(threadStateBlocks(state).map(b => b.text)).toEqual(["other tab"]);
  });
  it("keeps the in-flight thinking block's key stable across publishes", () => {
    // The state feed republishes the whole thread (~100ms) while thinking
    // streams; the reasoning block is not a durable event yet, so its key
    // must not change between publishes — a changing key remounts the
    // frame and snaps an expanded block shut mid-click.
    const state = { chat_id: "chat-1", seq: 7, events: [row(1, { type: "user_message", content: "go" })], text: "", thinking: "part one", generating: true };
    const first = threadStateBlocks(state).find(b => b.kind === "reasoning");
    const second = threadStateBlocks({ ...state, seq: 8, thinking: "part one part two" }).find(b => b.kind === "reasoning");
    expect(first?.key).toBeTruthy();
    expect(second?.key).toBe(first?.key);
    expect(second?.reasoningText).toBe("part one part two");
  });
  it("replaces a stale generating overlay from the server list", () => {
    expect(statusFromThreads([{ id: "chat-1", generating: false, unread: false } as any])).toEqual({ "chat-1": { generating: false, unread: false } });
  });
});

describe("offlineMachine (offline bound-machine banner)", () => {
  const base = { id: "chat-1", title: "t", created_at: "x" } as any;
  const bound = (machine_id: string, machine_online: boolean | undefined, machine_label?: string) =>
    ({ ...base, machine_id, machine_online, machine_label } as any);

  it("shows the label when the open chat's remote machine is offline", () => {
    expect(offlineMachine([bound("m1", false, "WORKSTATION")], "chat-1", true, "local")).toEqual({ label: "WORKSTATION" });
    // no label: fall back to the raw machine id
    expect(offlineMachine([bound("m1", false)], "chat-1", true, "local")).toEqual({ label: "m1" });
  });

  it("stays hidden for unbound chats and when the machine is online or unknown", () => {
    expect(offlineMachine([base], "chat-1", true, "local")).toBeNull();
    expect(offlineMachine([bound("m1", true, "WORKSTATION")], "chat-1", true, "local")).toBeNull();
    expect(offlineMachine([bound("m1", undefined, "WORKSTATION")], "chat-1", true, "local")).toBeNull();
    expect(offlineMachine([bound("m1", false, "WORKSTATION")], null, true, "local")).toBeNull();
  });

  it("skips the local machine on desktop, but banners every binding on web", () => {
    expect(offlineMachine([bound("local", false, "SELF")], "chat-1", true, "local")).toBeNull();
    expect(offlineMachine([bound("local", false, "SELF")], "chat-1", false, undefined)).toEqual({ label: "SELF" });
  });
});

describe("pending send reconciliation", () => {
  it("keeps the optimistic sending marker when resync history has no message yet", () => {
    const pending = {
      chatId: "chat-1",
      text: "still sending",
      key: "pending-1",
      sentAt: Date.parse("2026-09-16T00:00:00.000Z"),
    };
    expect(reconcilePendingSend([], [], pending)).toEqual([
      { kind: "user", text: "still sending", key: "pending-1", pending: true },
    ]);
  });

  it("settles only the matching server echo, independent of clock skew", () => {
    const pending = { chatId: "chat-1", text: "hello", key: "e1", sentAt: 9999999999999 };
    const rows = [row(1, { type: "user_message", content: "hello" })];
    const result = reconcilePendingSend(rows, eventsToBlocks(rows), pending);
    expect(result.some((block) => block.pending)).toBe(false);
    const otherTab = [row(2, { type: "user_message", content: "hello" })];
    expect(reconcilePendingSend(otherTab, eventsToBlocks(otherTab), pending).some(block => block.pending)).toBe(true);
  });
});

describe("parseSearchResults", () => {
  it("parses the numbered fallback format", () => {
    const out = parseSearchResults(
      ["1. First Result", "https://a.example/x", "first snippet", "2. Second", "https://b.example/"].join("\n"),
    );
    expect(out).toEqual([
      { url: "https://a.example/x", title: "First Result", snippet: "first snippet" },
      { url: "https://b.example/", title: "Second" },
    ]);
  });

  it("drops entries without a URL", () => {
    expect(parseSearchResults("1. Only a title\nno url here")).toEqual([]);
  });
});

describe("replayFrom", () => {
  it("keeps the whole list before the turn's first tool completes", () => {
    const frames = [
      { type: "thinking_delta", content: "hmm" },
      { type: "delta", content: "Hi" },
    ];
    expect(replayFrom(frames)).toEqual(frames);
  });

  it("drops everything up to the last completed tool — that is persisted", () => {
    const tail = [
      { type: "thinking_delta", content: "next step" },
      { type: "delta", content: "Working on it" },
    ];
    const frames = [
      { type: "delta", content: "step one text" },
      { type: "tool_started", call_id: "a", name: "execute" },
      { type: "tool_completed", call_id: "a", content: "ok" },
      ...tail,
    ];
    expect(replayFrom(frames)).toEqual(tail);
  });

  it("uses the LAST tool_completed, keeping a later suspended call visible", () => {
    const frames = [
      { type: "tool_started", call_id: "a" },
      { type: "tool_completed", call_id: "a" },
      { type: "tool_started", call_id: "b" },
    ];
    expect(replayFrom(frames)).toEqual([{ type: "tool_started", call_id: "b" }]);
  });

  it("returns an empty replay when the last frame is a completed tool", () => {
    const frames = [
      { type: "delta", content: "text" },
      { type: "tool_started", call_id: "a" },
      { type: "tool_completed", call_id: "a" },
    ];
    expect(replayFrom(frames)).toEqual([]);
  });
});

describe("compareVersions", () => {
  it("orders numerically, not lexically", () => {
    expect(compareVersions("0.3.10", "0.3.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.2", "0.10.1")).toBeLessThan(0);
    // missing segments count as 0
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
  });
});
