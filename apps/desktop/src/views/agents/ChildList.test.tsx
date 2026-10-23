import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Block, ChildRow as ChildRowData } from "../../lib/thread-reducer";
import type { ViewEntry } from "../worked-for-block";
import { ChildList, groupChildEntries } from "./ChildList";

function childRow(key: string, chatId: string | null): ChildRowData {
  return {
    threadId: `thread-${key}`,
    chatId,
    agentName: "Researcher",
    status: "succeeded",
    startedAt: "2026-10-22T10:00:00.000Z",
    finishedAt: "2026-10-22T10:00:05.000Z",
  };
}

function childEntry(key: string, chatId: string | null): ViewEntry {
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
      child: childRow(key, chatId),
    },
  };
  return { kind: "plain", b, i: 0 };
}

function textEntry(key: string): ViewEntry {
  return { kind: "plain", b: { kind: "text", text: "between", key }, i: 0 };
}

describe("child row grouping", () => {
  it("puts two consecutive child rows in one list with a count", () => {
    const groups = groupChildEntries([childEntry("a", "chat-a"), childEntry("b", "chat-b")]);
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.kind).toBe("child");
    if (group.kind !== "child") return;
    expect(group.rows.map((r) => r.key)).toEqual(["a", "b"]);

    const html = renderToStaticMarkup(<ChildList rows={group.rows} onOpen={() => {}} />);
    expect(html).toContain("Subagents");
    expect(html).toContain(">2<");
    expect(html.match(/Subagents/g)).toHaveLength(1);
  });

  it("splits the groups when a text block sits between them", () => {
    const groups = groupChildEntries([
      childEntry("a", "chat-a"),
      childEntry("b", "chat-b"),
      textEntry("t"),
      childEntry("c", "chat-c"),
    ]);
    expect(groups.map((g) => g.kind)).toEqual(["child", "entry", "child"]);
    const first = groups[0]!;
    const last = groups[2]!;
    expect(first.kind === "child" && first.rows.map((r) => r.key)).toEqual(["a", "b"]);
    expect(last.kind === "child" && last.rows.map((r) => r.key)).toEqual(["c"]);
  });
});
