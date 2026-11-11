// Markup contracts for the extracted tool frame widgets.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusPill, ToolFrame } from "./tool-blocks";
import { applyMachineList, clearMachinesCache } from "../../lib/machines-store";
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

  it("names the machine a call ran on, resolving the id to its label", () => {
    applyMachineList([
      {
        machine_id: "3f2a-machine",
        name: "MacBook",
        connected: true,
        first_connected_at: "2026-01-01T00:00:00Z",
        last_connected_at: "2026-01-01T00:00:00Z",
        last_seen_at: "2026-01-01T00:00:00Z",
      },
    ]);
    try {
      const html = renderToStaticMarkup(<ToolFrame t={tool({ args: '{"command":"ls","machine":"3f2a-machine"}' })} />);
      expect(html).toContain("on MacBook");
      expect(html).not.toContain("on 3f2a-machine");
      // A call without `machine` ran in the chat's own environment.
      expect(renderToStaticMarkup(<ToolFrame t={tool({})} />)).not.toContain(">on ");
    } finally {
      clearMachinesCache();
    }
  });
});
