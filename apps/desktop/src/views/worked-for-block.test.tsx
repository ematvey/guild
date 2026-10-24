// The worked-for row: one collapsible group per contiguous thinking/tool
// run, with the live or settled label and the step count on the header.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Block } from "../lib/thread-reducer";
import { WorkedForBlock } from "./worked-for-block";

const tool = (n: number, start: string, end: string): Block => ({
  kind: "tool",
  text: "",
  key: `t${n}`,
  tool: { callId: `c${n}`, name: "sh", args: "", executor: "server", status: "done", ts: start, endTs: end },
});

const run = [
  tool(1, "2026-10-15T12:00:00.000Z", "2026-10-15T12:00:03.000Z"),
  tool(2, "2026-10-15T12:00:03.000Z", "2026-10-15T12:00:07.000Z"),
];

describe("WorkedForBlock", () => {
  it("shows the settled label and step count, collapsed by default", () => {
    const html = renderToStaticMarkup(
      <WorkedForBlock run={run} active={false} stopping={false}>
        <span>detail</span>
      </WorkedForBlock>,
    );
    expect(html).toContain("Agent worked for 7 seconds");
    expect(html).toContain("(2 steps)");
    expect(html).not.toContain("detail");
  });

  it("uses the singular for one step and keeps the live label", () => {
    const html = renderToStaticMarkup(
      <WorkedForBlock run={[run[0]!]} active stopping={false}>
        <span>detail</span>
      </WorkedForBlock>,
    );
    expect(html).toContain("Agent is working");
    expect(html).toContain("(1 step)");
  });
});
