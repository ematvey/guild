import { describe, expect, it } from "vitest";
import { answeredBy, answersAfter, genuiOutcome } from "./actions";

describe("genuiOutcome", () => {
  it("sends the button's message", () => {
    expect(genuiOutcome({ type: "continue_conversation", params: {}, humanFriendlyMessage: "Tell me more" })).toEqual({
      kind: "send",
      text: "Tell me more",
    });
  });

  it("appends the submitted form's values, skipping empty fields", () => {
    const out = genuiOutcome({
      type: "continue_conversation",
      params: {},
      humanFriendlyMessage: "Plan it",
      formName: "trip",
      formState: {
        trip: {
          destination: { value: "Lisbon", componentType: "Input" },
          notes: { value: "", componentType: "TextArea" },
          flexible: { value: true, componentType: "Checkbox" },
        },
        other: { x: { value: "ignored" } },
      },
    });
    expect(out).toEqual({ kind: "send", text: "Plan it\n\ndestination: Lisbon\nflexible: yes" });
  });

  it("appends hidden context as JSON", () => {
    const out = genuiOutcome({
      type: "continue_conversation",
      params: { context: { orderId: 42 } },
      humanFriendlyMessage: "Show details",
    });
    expect(out).toEqual({ kind: "send", text: 'Show details\n\n{\n  "orderId": 42\n}' });
  });

  it("opens only web and mail links", () => {
    expect(genuiOutcome({ type: "open_url", params: { url: "https://x.dev" }, humanFriendlyMessage: "" })).toEqual({
      kind: "open",
      url: "https://x.dev",
    });
    expect(
      genuiOutcome({ type: "open_url", params: { url: "javascript:alert(1)" }, humanFriendlyMessage: "" }),
    ).toEqual({ kind: "none" });
    expect(genuiOutcome({ type: "open_url", params: { url: "file:///etc/passwd" }, humanFriendlyMessage: "" })).toEqual(
      { kind: "none" },
    );
  });

  it("drops custom actions and empty sends", () => {
    expect(genuiOutcome({ type: "Delete", params: {}, humanFriendlyMessage: "x" })).toEqual({ kind: "none" });
    expect(genuiOutcome({ type: "continue_conversation", params: {}, humanFriendlyMessage: "  " })).toEqual({
      kind: "none",
    });
  });
});

describe("answersAfter", () => {
  it("gives each block the first user message after it", () => {
    const blocks = [
      { kind: "user", text: "hi" },
      { kind: "text", text: "form" },
      { kind: "tool" },
      { kind: "text", text: "more" },
      { kind: "user", text: "Plan it\n\ndestination: Lisbon" },
      { kind: "text", text: "done" },
    ];
    expect(answersAfter(blocks)).toEqual([
      "Plan it\n\ndestination: Lisbon",
      "Plan it\n\ndestination: Lisbon",
      "Plan it\n\ndestination: Lisbon",
      "Plan it\n\ndestination: Lisbon",
      null,
      null,
    ]);
  });
});

describe("answeredBy", () => {
  it("matches the button's message, alone or followed by form values", () => {
    expect(answeredBy("Plan it", "Plan it")).toBe(true);
    expect(answeredBy("Plan it\n\ndestination: Lisbon", "Plan it")).toBe(true);
    expect(answeredBy("Plan it later", "Plan it")).toBe(false);
    expect(answeredBy(null, "Plan it")).toBe(false);
  });
});
