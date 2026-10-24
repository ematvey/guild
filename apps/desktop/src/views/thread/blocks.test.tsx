// Markup contracts for the extracted transcript blocks.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { CompactionCard, HoverStamp, ReasoningFrame, ThreadSkeleton } from "./blocks";

describe("ReasoningFrame", () => {
  it("labels a live reasoning block as Thinking…", () => {
    const html = renderToStaticMarkup(<ReasoningFrame text="checking files" live />);
    expect(html).toContain("Thinking…");
    expect(html).toContain("checking files");
  });

  it("labels a finished block as Thinking", () => {
    const html = renderToStaticMarkup(<ReasoningFrame text="done" live={false} />);
    expect(html).toContain("Thinking");
    expect(html).not.toContain("Thinking…");
  });
});

describe("CompactionCard", () => {
  it("names the event on the collapsed header", () => {
    const html = renderToStaticMarkup(
      <CompactionCard c={{ summary: "earlier work", keepLast: 6 }} />,
    );
    expect(html).toContain("Context compacted");
  });
});

describe("HoverStamp", () => {
  it("renders nothing without a stamp", () => {
    expect(renderToStaticMarkup(<HoverStamp side="left" />)).toBe("");
    expect(renderToStaticMarkup(<HoverStamp ts="not-a-date" side="left" />)).toBe("");
  });

  it("renders the formatted time", () => {
    const html = renderToStaticMarkup(<HoverStamp ts={new Date().toISOString()} side="right" />);
    expect(html).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("ThreadSkeleton", () => {
  it("announces the loading state", () => {
    const html = renderToStaticMarkup(<ThreadSkeleton width={720} />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading conversation");
  });
});
