// The running subagent tree: only the running part of the chat's subtree is
// kept, so a finished branch never shows below the transcript.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatSubagentNode } from "../../lib/api/chats";
import { countRunning, isRunningStatus, RunningSubagents, runningSubagentTree, SubagentTree } from "./RunningSubagents";

function node(over: Partial<ChatSubagentNode> & { thread_id: string }): ChatSubagentNode {
  return {
    chat_id: `chat-${over.thread_id}`,
    parent_thread_id: null,
    agent_name: "Researcher",
    title: over.thread_id,
    depth: 0,
    status: null,
    ...over,
  };
}

describe("runningSubagentTree", () => {
  it("keeps a running child and its running grandchild", () => {
    const tree = runningSubagentTree([
      node({ thread_id: "root" }),
      node({ thread_id: "child", parent_thread_id: "root", status: "running", depth: 1 }),
      node({ thread_id: "grand", parent_thread_id: "child", status: "queued", depth: 2 }),
    ]);
    expect(tree?.node.thread_id).toBe("root");
    expect(tree?.children.map((c) => c.node.thread_id)).toEqual(["child"]);
    expect(tree?.children[0]!.children.map((c) => c.node.thread_id)).toEqual(["grand"]);
  });

  it("drops a finished branch but keeps a finished parent with a running grandchild", () => {
    const tree = runningSubagentTree([
      node({ thread_id: "root" }),
      node({ thread_id: "done", parent_thread_id: "root", status: "succeeded", depth: 1 }),
      node({ thread_id: "live", parent_thread_id: "root", status: "running", depth: 1 }),
      node({ thread_id: "grand", parent_thread_id: "done", status: "running", depth: 2 }),
    ]);
    expect(tree?.children.map((c) => c.node.thread_id)).toEqual(["done", "live"]);
    expect(tree?.children[0]!.children.map((c) => c.node.thread_id)).toEqual(["grand"]);
  });

  it("finds the root of a child chat's own subtree", () => {
    // The chat's own thread names its parent thread, which is outside the
    // returned subtree: the running tree must still start below it.
    const tree = runningSubagentTree([
      node({ thread_id: "child", parent_thread_id: "parent-thread", status: "running", depth: 1 }),
      node({ thread_id: "grand", parent_thread_id: "child", status: "running", depth: 2 }),
    ]);
    expect(tree?.node.thread_id).toBe("child");
    expect(tree?.children.map((c) => c.node.thread_id)).toEqual(["grand"]);
  });

  it("is null when nothing runs", () => {
    expect(
      runningSubagentTree([
        node({ thread_id: "root" }),
        node({ thread_id: "child", parent_thread_id: "root", status: "succeeded", depth: 1 }),
      ]),
    ).toBeNull();
  });

  it("is null for a chat with no thread row", () => {
    expect(runningSubagentTree([])).toBeNull();
  });

  it("treats queued and running as live", () => {
    expect(isRunningStatus("running")).toBe(true);
    expect(isRunningStatus("queued")).toBe(true);
    expect(isRunningStatus("succeeded")).toBe(false);
    expect(isRunningStatus(null)).toBe(false);
  });
});

describe("RunningSubagents", () => {
  const nodes: ChatSubagentNode[] = [
    node({ thread_id: "root", title: "im testing a subagent tree. spawn subagents inst" }),
    node({ thread_id: "child", parent_thread_id: "root", status: "running", depth: 1, title: "T1-A" }),
    node({ thread_id: "grand", parent_thread_id: "child", status: "running", depth: 2, title: "T1-A-1" }),
  ];

  it("counts only the live nodes in the kept tree", () => {
    const tree = runningSubagentTree(nodes)!;
    expect(countRunning(tree)).toBe(2);
  });

  it("collapses to a counted header and never renders the chat's own title", () => {
    const html = renderToStaticMarkup(<RunningSubagents nodes={nodes} onOpen={() => {}} />);
    expect(html).toContain("Subagents working");
    expect(html).toContain("(2)");
    expect(html).not.toContain("Researcher · T1-A");
    expect(html).not.toContain("im testing a subagent tree");
  });

  it("the expanded tree names every kept node", () => {
    const html = renderToStaticMarkup(
      <SubagentTree tree={runningSubagentTree(nodes)!} onOpen={() => {}} />,
    );
    expect(html).toContain("Researcher · T1-A");
    expect(html).toContain("Researcher · T1-A-1");
    expect(html).not.toContain("im testing a subagent tree");
  });

  it("renders nothing when no descendant runs", () => {
    const done = nodes.map((n) => ({ ...n, status: "succeeded" }));
    expect(renderToStaticMarkup(<RunningSubagents nodes={done} onOpen={() => {}} />)).toBe("");
  });
});
