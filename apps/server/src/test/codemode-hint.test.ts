// The post-run codemode hint: pure functions over a script's nested calls.

import { describe, expect, it } from "vitest";
import { serialCallsHint, withSerialCallsHint } from "../harness/codemode-hint.js";

const calls = (...durations: number[]): { durationMs: number }[] => durations.map((durationMs) => ({ durationMs }));

describe("serialCallsHint", () => {
  it("says nothing below four calls", () => {
    expect(serialCallsHint(calls(1000, 1000, 1000), 3200)).toBeUndefined();
  });

  it("says nothing below two seconds of tool time", () => {
    expect(serialCallsHint(calls(100, 100, 100, 100), 450)).toBeUndefined();
  });

  it("says nothing when the calls overlapped", () => {
    // Four 2s calls in a 2.5s script: they ran together.
    expect(serialCallsHint(calls(2000, 2000, 2000, 2000), 2500)).toBeUndefined();
  });

  it("names the serial chain and the batching pattern", () => {
    const hint = serialCallsHint(calls(2000, 2000, 2000, 2000), 8500);
    expect(hint).toContain("4 tool calls ran one after another");
    expect(hint).toContain("8.0s of 8.5s");
    expect(hint).toContain("Promise.all");
  });

  it("ignores calls with no duration", () => {
    expect(serialCallsHint([{}, {}, {}, {}], 9000)).toBeUndefined();
  });
});

describe("withSerialCallsHint", () => {
  it("appends one text item and keeps the result", () => {
    const result = withSerialCallsHint(
      {
        output: [{ type: "text" as const, text: "done" }],
        isError: false,
        details: { calls: calls(2000, 2000, 2000, 2000) },
      },
      8500,
    );
    expect(result.isError).toBe(false);
    expect(result.details).toEqual({ calls: calls(2000, 2000, 2000, 2000) });
    expect(result.output).toHaveLength(2);
    expect(result.output?.[1]).toMatchObject({ type: "text" });
  });

  it("returns the result unchanged without a serial chain", () => {
    const original = { output: [{ type: "text" as const, text: "done" }], isError: false };
    expect(withSerialCallsHint(original, 8500)).toBe(original);
  });

  it("returns the result unchanged without details", () => {
    const original = { isError: true };
    expect(withSerialCallsHint(original, 8500)).toBe(original);
  });
});
