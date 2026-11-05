// Markup contracts for Generated UI blocks inside message markdown.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { CHAT_MD_PLUGINS, mdComponents } from "../markdown";
import { GenuiHostContext } from "./actions";

const md = (text: string, host = true) =>
  renderToStaticMarkup(
    <GenuiHostContext.Provider value={host ? { send: () => {} } : null}>
      <Markdown remarkPlugins={CHAT_MD_PLUGINS} components={mdComponents}>
        {text}
      </Markdown>
    </GenuiHostContext.Provider>,
  );

const BLOCK = [
  "Here is the summary:",
  "",
  "```openui",
  "root = Stack([kpis, tbl, next])",
  'kpis = Grid([Metric("Open tickets", 42, "-8%", "down"), Metric("CSAT", "94%")])',
  'tbl = Table(["Team", "Open"], [["Core", 12], ["Billing", 30]])',
  'next = Buttons([Button("Break down by team", @ToAssistant("Break it down"))])',
  "```",
  "",
  "Anything else?",
].join("\n");

describe("Generated UI blocks", () => {
  it("render an openui fence as components between the prose", () => {
    const html = md(BLOCK);
    expect(html).toContain("Here is the summary:");
    expect(html).toContain("data-genui");
    expect(html).toContain("Open tickets");
    expect(html).toContain("Billing");
    expect(html).toContain("Break down by team");
    expect(html).toContain("Anything else?");
    expect(html).not.toContain("root = Stack");
  });

  it("leave other code blocks as code", () => {
    const html = md("```ts\nconst x = 1;\n```");
    expect(html).toContain("<pre>");
    expect(html).toContain("const x = 1;");
    expect(html).not.toContain("data-genui");
  });

  it("disable the controls where nothing can be sent", () => {
    expect(md(BLOCK, false)).toMatch(/<fieldset disabled=""/);
    expect(md(BLOCK, true)).not.toMatch(/<fieldset disabled=""/);
  });
});
