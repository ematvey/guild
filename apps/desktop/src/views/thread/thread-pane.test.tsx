// Markup contracts for the transcript pane's turn folding: the open turn
// shows every agent message; a settled turn keeps only its last one and the
// rest sit behind the worked-for row.
import { createRef } from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { RenderBlock } from "../../lib/thread-reducer";
import { ThreadPane } from "./thread-pane";

const blocks: RenderBlock[] = [
  { kind: "user", text: "go", key: "u", ts: "2026-10-15T12:00:00.000Z" },
  { kind: "text", text: "first message", key: "x1", ts: "2026-10-15T12:00:01.000Z" },
  {
    kind: "tool",
    text: "",
    key: "t2",
    ts: "2026-10-15T12:00:02.000Z",
    tool: {
      callId: "c",
      name: "sh",
      args: "",
      executor: "server",
      status: "done",
      ts: "2026-10-15T12:00:02.000Z",
      endTs: "2026-10-15T12:00:05.000Z",
    },
  },
  { kind: "text", text: "final message", key: "x3", ts: "2026-10-15T12:00:06.000Z" },
];

function render(busy: boolean): string {
  return renderToStaticMarkup(
    <ThreadPane
      blocks={blocks}
      loading={false}
      viewChatId="chat"
      noModels={false}
      navigating={false}
      hasMore={false}
      loadingEarlier={false}
      onLoadEarlier={() => {}}
      compacting={false}
      busy={busy}
      stopping={{}}
      subagentNodes={[]}
      originLink={null}
      onOpenChat={() => {}}
      onOpenChildChat={() => {}}
      scroll={{
        pane: createRef<HTMLDivElement>(),
        onScroll: () => {},
        setContentEl: () => {},
        composerH: 0,
        onFrameToggle: () => {},
        atBottom: true,
        scrollToBottom: () => {},
      }}
    />,
  );
}

describe("ThreadPane turn folding", () => {
  it("shows every message of the open turn as it arrives", () => {
    const html = render(true);
    expect(html).toContain("first message");
    expect(html).toContain("final message");
  });

  it("keeps only the final message once the turn settles", () => {
    const html = render(false);
    expect(html).not.toContain("first message");
    expect(html).toContain("final message");
    expect(html).toContain("Agent worked for 4s");
  });
});
