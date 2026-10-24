// Markup contracts for the extracted tool frame widgets.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusPill, ToolFrame } from "./tool-blocks";
import type { ToolBlock } from "../../lib/thread-reducer";

const tool = (over: Partial<ToolBlock>): ToolBlock => ({
  callId: "c1",
  name: "execute",
  args: '{"command":"ls -la"}',
  executor: "server",
  status: "done",
  ...over,
});

describe("StatusPill", () => {
  it("renders the status word", () => {
    expect(renderToStaticMarkup(<StatusPill status="running" />)).toContain("running");
    expect(renderToStaticMarkup(<StatusPill status="error" />)).toContain("error");
  });
});

describe("ToolFrame", () => {
  it("shows the human label and the request preview on the header line", () => {
    const html = renderToStaticMarkup(<ToolFrame t={tool({})} />);
    expect(html).toContain("Execute");
    expect(html).toContain("ls -la");
  });

  it("maps the native web kinds to their labels", () => {
    expect(renderToStaticMarkup(<ToolFrame t={tool({ kind: "web_search", name: "x" })} />)).toContain("Web search");
    expect(renderToStaticMarkup(<ToolFrame t={tool({ kind: "web_browse", name: "x" })} />)).toContain("Browse");
  });

  it("shows an error pill only for a failed call", () => {
    const ok = renderToStaticMarkup(<ToolFrame t={tool({})} />);
    expect(ok).not.toContain(">error<");
    const failed = renderToStaticMarkup(<ToolFrame t={tool({ status: "error" })} />);
    expect(failed).toContain(">error<");
  });
});
