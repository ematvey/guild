import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Block, ChildRow as ChildRowData } from "../../lib/thread-reducer";
import type { ViewEntry } from "../worked-for-block";
import { ChildList, childRowsOf } from "./ChildList";

function childRow(threadId: string, chatId: string | null): ChildRowData {
  return {
    threadId,
    chatId,
    agentName: "Researcher",
    status: "succeeded",
    startedAt: "2026-10-22T10:00:00.000Z",
    finishedAt: "2026-10-22T10:00:05.000Z",
  };
}

function childEntry(key: string, threadId: string, chatId: string | null = `chat-${threadId}`): ViewEntry {
  const b: Block = {
    kind: "tool",
    text: "",
    key,
    tool: {
      callId: key,
      name: "spawn",
      args: "",
      executor: "server",
      status: "done",
      child: childRow(threadId, chatId),
    },
  };
  return { kind: "plain", b, i: 0 };
}

function textEntry(key: string): ViewEntry {
  return { kind: "plain", b: { kind: "text", text: "between", key }, i: 0 };
}

describe("childRowsOf", () => {
  it("returns child rows in transcript order", () => {
    const rows = childRowsOf([
      childEntry("a", "thread-a"),
      textEntry("t"),
      childEntry("b", "thread-b"),
    ]);
    expect(rows.map((r) => r.row.threadId)).toEqual(["thread-a", "thread-b"]);
    expect(rows.map((r) => r.key)).toEqual(["thread-a", "thread-b"]);
  });

  it("dedupes by thread id and keeps the child in its spawn position", () => {
    const rows = childRowsOf([
      childEntry("a", "thread-a"),
      childEntry("b", "thread-b"),
      childEntry("c", "thread-a"),
    ]);
    expect(rows.map((r) => r.row.threadId)).toEqual(["thread-a", "thread-b"]);
  });

  it("returns no rows when there are no children", () => {
    expect(childRowsOf([textEntry("t")])).toEqual([]);
    expect(childRowsOf([])).toEqual([]);
  });
});

describe("ChildList", () => {
  it("renders the subagent count", () => {
    const rows = childRowsOf([childEntry("a", "thread-a"), childEntry("b", "thread-b")]);
    const html = renderToStaticMarkup(<ChildList rows={rows} onOpen={() => {}} />);
    expect(html).toContain("Subagents");
    expect(html).toContain(">2<");
    expect(html.match(/Subagents/g)).toHaveLength(1);
  });

  it("renders nothing when empty", () => {
    const html = renderToStaticMarkup(<ChildList rows={[]} onOpen={() => {}} />);
    expect(html).toBe("");
  });
});

describe("child row labels", () => {
  it("shows the spawner's session name first and the agent name beside it", () => {
    const html = renderToStaticMarkup(
      <ChildList
        rows={[
          {
            key: "thread-a",
            row: {
              threadId: "thread-a",
              chatId: "chat-a",
              agentName: "Echo",
              title: "market scan",
              status: "running",
              startedAt: new Date().toISOString(),
            },
          },
        ]}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain("market scan");
    expect(html).toContain("Echo");
  });

  it("falls back to the agent name when the spawner gave no session name", () => {
    const html = renderToStaticMarkup(
      <ChildList
        rows={[
          {
            key: "thread-b",
            row: {
              threadId: "thread-b",
              chatId: "chat-b",
              agentName: "Scout",
              title: null,
              status: "succeeded",
              startedAt: new Date().toISOString(),
            },
          },
        ]}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain("Scout");
  });
});

function childEntryWith(key: string, row: Record<string, unknown>): ViewEntry {
  return {
    kind: "plain",
    b: {
      kind: "tool",
      key,
      tool: { callId: key, name: "codemode", args: "", executor: "server", status: "done", child: row },
    },
    i: 0,
  } as unknown as ViewEntry;
}

describe("child row merging", () => {
  const child = (over: Record<string, unknown>) => ({
    threadId: "",
    agentName: "Echo",
    status: "running",
    startedAt: "2026-10-23T00:00:00Z",
    ...over,
  });

  it("merges a spawn call with its later child_result", () => {
    const rows = childRowsOf([
      childEntryWith("a", child({ title: "market scan" })),
      childEntryWith("b", child({ threadId: "thread-a", chatId: "chat-a", title: "market scan", status: "succeeded" })),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.row).toMatchObject({ threadId: "thread-a", chatId: "chat-a", status: "succeeded" });
  });

  it("keeps two children of the same agent apart", () => {
    const rows = childRowsOf([
      childEntryWith("a", child({ title: "first" })),
      childEntryWith("b", child({ title: "second" })),
      childEntryWith("c", child({ threadId: "thread-1", chatId: "chat-1", title: "first", status: "succeeded" })),
      childEntryWith("d", child({ threadId: "thread-2", chatId: "chat-2", title: "second", status: "succeeded" })),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.row.chatId)).toEqual(["chat-1", "chat-2"]);
  });
});
