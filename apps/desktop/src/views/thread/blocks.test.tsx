// Markup contracts for the extracted transcript blocks.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import {
  CompactionCard,
  MessageStamp,
  ReasoningFrame,
  ThreadProgress,
  ThreadSkeleton,
  ThreadTitle,
  prettyStamp,
} from "./blocks";
import { CHAT_MD_PLUGINS, mdComponents } from "../markdown";

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
    const html = renderToStaticMarkup(<CompactionCard c={{ summary: "earlier work", keepLast: 6 }} />);
    expect(html).toContain("Context compacted");
  });
});

describe("chat markdown", () => {
  it("keeps a newline the model wrote", () => {
    const html = renderToStaticMarkup(
      <Markdown remarkPlugins={CHAT_MD_PLUGINS} components={mdComponents}>
        {"Header\n\n• one\n• two"}
      </Markdown>,
    );
    expect(html).toContain("• one<br");
    expect(html).toContain("• two");
  });
});

describe("MessageStamp", () => {
  it("renders nothing without a stamp", () => {
    expect(renderToStaticMarkup(<MessageStamp />)).toBe("");
    expect(renderToStaticMarkup(<MessageStamp ts="not-a-date" />)).toBe("");
  });

  it("renders the formatted time", () => {
    const html = renderToStaticMarkup(<MessageStamp ts={new Date().toISOString()} />);
    expect(html).toMatch(/\d{1,2}:\d{2}/);
    expect(html).not.toContain("Copy message");
  });

  it("shows the time without a hover", () => {
    const html = renderToStaticMarkup(<MessageStamp ts={new Date().toISOString()} />);
    expect(html).not.toContain("opacity-0");
    expect(html).not.toContain("group-hover");
  });

  it("puts the copy button before the time", () => {
    const html = renderToStaticMarkup(<MessageStamp ts={new Date().toISOString()} copyText="hi" />);
    expect(html).toContain('aria-label="Copy message"');
    expect(html.indexOf("Copy message")).toBeLessThan(html.search(/\d{1,2}:\d{2}/));
  });

  it("renders the copy button without a stamp", () => {
    expect(renderToStaticMarkup(<MessageStamp copyText="hi" />)).toContain("Copy message");
  });
});

describe("ThreadSkeleton", () => {
  it("announces the loading state", () => {
    const html = renderToStaticMarkup(<ThreadSkeleton />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading conversation");
    expect(html).toContain("px-4");
  });
});

describe("ThreadProgress", () => {
  it("sweeps a soft band with no idle track", () => {
    const html = renderToStaticMarkup(<ThreadProgress />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain("Loading thread");
    expect(html).toContain("animate-thread-progress");
    expect(html).not.toContain("animate-pulse");
    expect(html).not.toContain("bg-border");
  });
});

describe("ThreadTitle", () => {
  it("names an unnamed chat instead of holding a skeleton open", () => {
    const html = renderToStaticMarkup(<ThreadTitle chatId="c1" title="" loading={false} />);
    expect(html).toContain("New thread");
    expect(html).not.toContain("Loading title");
  });

  it("shows a fixed-size placeholder while the chat is still loading", () => {
    const html = renderToStaticMarkup(<ThreadTitle chatId="c1" title="" loading />);
    expect(html).toContain('aria-label="Loading title"');
    expect(html).toContain("w-28");
  });

  it("renders the title once it is known", () => {
    const html = renderToStaticMarkup(<ThreadTitle chatId="c1" title="Deploy notes" loading={false} />);
    expect(html).toContain("Deploy notes");
    expect(html).not.toContain("Loading title");
  });
});

describe("prettyStamp", () => {
  it("formats a timestamp consistently and caches the result", () => {
    const iso = new Date().toISOString();
    const first = prettyStamp(iso);
    expect(first).toBe(prettyStamp(iso));
    expect(first).toMatch(/\d{1,2}:\d{2}/);
    expect(prettyStamp("not-a-date")).toBe("");
  });
});
