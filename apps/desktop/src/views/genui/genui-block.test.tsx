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

  it("render a reply the dev model actually wrote", () => {
    const html = md(
      [
        "Here's the snapshot:",
        "",
        "```openui",
        "root = Stack([kpis, chartCard, next])",
        "kpis = Grid([m1, m2, m3], 3)",
        'm1 = Metric("Q3 revenue", "$1.2M", "+14%", "up")',
        'm2 = Metric("Churn", "2.1%", "-0.4pp", "down")',
        'm3 = Metric("New customers", 312, "+", "up")',
        'chartCard = Card([chart], "Monthly revenue", "Q3, in $k")',
        'chart = BarChart(["Jul", "Aug", "Sep"], [Series("Revenue ($k)", [380, 400, 420])])',
        'next = Buttons([Button("Break down revenue", @ToAssistant("Break down Q3 revenue by segment")), Button("Q4 outlook", @ToAssistant("Build a Q4 outlook"))])',
        "```",
      ].join("\n"),
    );
    expect(html).toContain("Q3 revenue");
    expect(html).toContain("312");
    expect(html).toContain("Monthly revenue");
    expect(html).toContain("Break down revenue");
    expect(html).toContain("Q4 outlook");
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
