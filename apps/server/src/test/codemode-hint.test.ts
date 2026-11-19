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

  it("says nothing when combined tool time clearly exceeds wall time", () => {
    // Four 2s calls in a 2.5s script: they ran together.
    expect(serialCallsHint(calls(2000, 2000, 2000, 2000), 2500)).toBeUndefined();
  });

  it("suggests batching conditionally and preserves side-effect ordering", () => {
    const hint = serialCallsHint(calls(2000, 2000, 2000, 2000), 8500);
    expect(hint).toContain("4 tool calls used 8.0s combined in 8.5s wall time");
    expect(hint).toContain("If independent reads ran sequentially");
    expect(hint).toContain("tools.x({ item })");
    expect(hint).toContain("side effects");
    expect(hint).toContain("Promise.all");
  });

  it("does not label an uneven parallel batch as measured serial work", () => {
    const hint = serialCallsHint(calls(4000, 100, 100, 100), 4000);
    expect(hint).toContain("If independent reads ran sequentially");
    expect(hint).not.toContain("ran one after another");
  });

  it("hints at thirty percent tool time, but not below it", () => {
    expect(serialCallsHint(calls(750, 750, 750, 750), 10000)).toContain("Promise.all");
    expect(serialCallsHint(calls(750, 750, 750, 750), 10001)).toBeUndefined();
  });

  it("hints on the recorded list lookup and retry batches", () => {
    const lookups = Array.from({ length: 61 }, () => ({ durationMs: 88711 / 61 }));
    const retries = Array.from({ length: 34 }, () => ({ durationMs: 49097 / 34 }));
    expect(serialCallsHint(lookups, 147289)).toContain("61 tool calls");
    expect(serialCallsHint(retries, 81329)).toContain("34 tool calls");
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
