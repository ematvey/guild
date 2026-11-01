import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatTree } from "../../lib/api/chats";
import { ChildThreadHeader } from "./ChildThreadHeader";

const childTree: ChatTree = {
  chat_id: "child-chat",
  type: "subagent",
  archived: false,
  deleted: false,
  own: true,
  title: "market scan",
  agent_id: "a1",
  agent_name: "Echo",
  status: "running",
  depth: 1,
  parent: { chat_id: "parent-chat", title: "Parent session" },
  origin: null,
};

describe("ChildThreadHeader", () => {
  it("renders the back control, child title and agent name", () => {
    const html = renderToStaticMarkup(
      <ChildThreadHeader tree={childTree} onBack={() => {}} />,
    );
    expect(html).toContain("Parent session");
    expect(html).toContain("Back to Parent session");
    expect(html).toContain("market scan");
    expect(html).toContain("Echo");
    // The header carries no status: the running tree below the transcript is
    // the only place a subagent's state shows.
    expect(html).not.toContain("Running");
    expect(html).not.toContain("Succeeded");
  });

  it("renders nothing for a plain chat", () => {
    const plain: ChatTree = {
      ...childTree,
      type: "user",
      depth: 0,
      parent: null,
    };
    expect(renderToStaticMarkup(<ChildThreadHeader tree={plain} onBack={() => {}} />)).toBe("");
    expect(renderToStaticMarkup(<ChildThreadHeader tree={null} onBack={() => {}} />)).toBe("");
  });
});
