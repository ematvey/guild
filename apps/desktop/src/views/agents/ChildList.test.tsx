import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChildRow as ChildRowData } from "../../lib/thread-reducer";
import { ChildList, childRowsOf, subagentsCollapsed } from "./ChildList";

function childRow(threadId: string, chatId: string | null, over: Partial<ChildRowData> = {}): ChildRowData {
  return {
    threadId,
    chatId,
    agentName: "Researcher",
    status: "succeeded",
    startedAt: "2026-10-22T10:00:00.000Z",
    finishedAt: "2026-10-22T10:00:05.000Z",
    ...over,
  };
}

describe("childRowsOf", () => {
  it("returns rows from the children list in spawn order", () => {
    const rows = childRowsOf([
      childRow("thread-a", "chat-a"),
      childRow("thread-b", "chat-b"),
    ]);
    expect(rows.map((r) => r.row.threadId)).toEqual(["thread-a", "thread-b"]);
    expect(rows.map((r) => r.key)).toEqual(["thread-a", "thread-b"]);
  });

  it("dedupes by thread id and keeps the child in its spawn position", () => {
    const rows = childRowsOf([
      childRow("thread-a", "chat-a"),
      childRow("thread-b", "chat-b"),
      childRow("thread-a", "chat-a", { status: "failed" }),
    ]);
    expect(rows.map((r) => r.row.threadId)).toEqual(["thread-a", "thread-b"]);
    expect(rows[0]!.row.status).toBe("failed");
  });

  it("does not render a row without a chat id", () => {
    const rows = childRowsOf([
      childRow("thread-a", null),
      childRow("thread-b", "chat-b"),
    ]);
    expect(rows.map((r) => r.row.threadId)).toEqual(["thread-b"]);
  });

  it("returns no rows when there are no children", () => {
    expect(childRowsOf([])).toEqual([]);
  });
});

describe("ChildList", () => {
  it("renders the subagent count", () => {
    const rows = childRowsOf([
      childRow("thread-a", "chat-a"),
      childRow("thread-b", "chat-b"),
    ]);
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
        rows={childRowsOf([
          childRow("thread-a", "chat-a", { agentName: "Echo", title: "market scan", status: "running" }),
        ])}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain("market scan");
    expect(html).toContain("Echo");
  });

  it("falls back to the agent name when the spawner gave no session name", () => {
    const html = renderToStaticMarkup(
      <ChildList
        rows={childRowsOf([
          childRow("thread-b", "chat-b", { agentName: "Scout", title: null }),
        ])}
        onOpen={() => {}}
      />,
    );
    expect(html).toContain("Scout");
  });
});

describe("subagent panel collapse", () => {
  it("reads the stored choice", () => {
    expect(subagentsCollapsed("1")).toBe(true);
    expect(subagentsCollapsed("0")).toBe(false);
    expect(subagentsCollapsed(null)).toBe(false);
  });

  it("renders the header as a toggle that controls the rows", () => {
    const rows = childRowsOf([childRow("thread-a", "chat-a")]);
    const html = renderToStaticMarkup(<ChildList rows={rows} onOpen={() => {}} />);
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-controls="subagent-rows"');
    expect(html).toContain('id="subagent-rows"');
  });

  it("counts the running children in the header", () => {
    const rows = childRowsOf([
      childRow("thread-a", "chat-a", { status: "running", finishedAt: undefined }),
      childRow("thread-b", "chat-b"),
    ]);
    const html = renderToStaticMarkup(<ChildList rows={rows} onOpen={() => {}} />);
    expect(html).toContain("1 running");
  });
});
