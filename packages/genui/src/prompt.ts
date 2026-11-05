// The prompt section that teaches an agent to write Generated UI: when a
// reply may carry an `openui` block, the OpenUI Lang syntax, and the
// component signatures generated from the library.

import { GENUI_COMPONENTS, genuiLibrary, type GenuiComponentName } from "./library.js";

/** The fence language of a Generated UI block. `openui-lang` is accepted
 *  too, since that is the name the upstream prompt examples use. */
export const GENUI_FENCE = "openui";
export const GENUI_FENCES: readonly string[] = [GENUI_FENCE, "openui-lang"];

const PREAMBLE = `Your replies are Markdown. A reply may also carry interactive UI: a program in openui-lang, a small declarative UI language, inside a fenced code block tagged \`${GENUI_FENCE}\`. The app renders the block in place as live components; text outside the fence stays Markdown.

Use a UI block when structure serves the user better than prose:
- several key numbers → Metrics in a Grid
- comparisons or records → Table or Facts
- numeric series or trends → BarChart / LineChart / PieChart
- you need several inputs from the user → a Form
- the user should pick a next step → Buttons or FollowUps
- pictures, diagrams or screenshots → Image (send_file a workspace image first, then use "attachment:<id>")
- a process or plan → Steps; secondary detail → Accordion or Modal
Do not use it for ordinary prose, short answers, code, or file contents. Keep the explanation in Markdown around the block, not inside it. Every block is a complete program that starts with \`root = Stack(...)\`; a reply may hold more than one block. Never wrap an \`${GENUI_FENCE}\` block inside another code block.

When the user clicks a button with @ToAssistant("message"), you receive "message" as their next message, followed by the form's field values when the button sits in a Form. Clicks never run tools by themselves; @Set/@Reset only change the block's own $variables (filters, toggles) and send nothing. A block takes one answer: once the user replies (by a click or by typing), its buttons and fields lock, so to ask again, send a new block.`;

const EXAMPLES = [
  `Example — a status summary:

\`\`\`${GENUI_FENCE}
root = Stack([kpis, trend, next])
kpis = Grid([m1, m2, m3])
m1 = Metric("Open tickets", 42, "-8%", "down")
m2 = Metric("Median response", "3h 10m", "+12%", "up")
m3 = Metric("CSAT", "94%")
trend = Card([chart], "Tickets per week")
chart = LineChart(["W1", "W2", "W3", "W4"], [Series("Opened", [51, 47, 44, 42]), Series("Closed", [40, 49, 46, 45])])
next = Buttons([Button("Break down by team", @ToAssistant("Break the open tickets down by team")), Button("Show the oldest", @ToAssistant("List the 10 oldest open tickets"), "secondary")])
\`\`\``,
  `Example — collecting input:

\`\`\`${GENUI_FENCE}
root = Stack([form])
form = Form("trip", [dest, dates, notes], Buttons([Button("Plan it", @ToAssistant("Plan the trip with these details"))]))
dest = Field("Destination", Input("destination", "City or region", "text", {required: true}))
dates = Field("Dates", Input("dates", "e.g. 12–19 May"))
notes = Field("Anything else", TextArea("notes", "Budget, pace, must-sees"))
\`\`\``,
];

let cached: string | null = null;

/** The Generated UI section of an agent's instructions. Deterministic, so
 *  it never disturbs prompt caching between turns. */
export function genuiPrompt(): string {
  if (cached === null) {
    const renderers = Object.fromEntries(Object.keys(GENUI_COMPONENTS).map((n) => [n, null])) as Record<
      GenuiComponentName,
      null
    >;
    const library = genuiLibrary(renderers);
    cached = library.prompt({
      preamble: PREAMBLE,
      bindings: true,
      builtinFunctions: true,
      examples: EXAMPLES,
      additionalRules: [
        `Only the components listed above exist. Unknown components and invalid lines are dropped silently.`,
        `Put labels and units in the data you show; never invent numbers you have not got.`,
      ],
    });
  }
  return cached;
}
