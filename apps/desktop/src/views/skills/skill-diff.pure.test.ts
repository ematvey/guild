// Pure tests for the publish guard's line diff (no DOM, no server): the
// LCS row sequence for additions, removals, modifications and unchanged
// input. These run under `npm test` (vitest); see package.json.

import { describe, expect, it } from "vitest";
import { diffLines } from "./skill-diff";

describe("diffLines", () => {
  it("returns all-context rows for identical input", () => {
    expect(diffLines("a\nb", "a\nb")).toEqual([
      { type: "ctx", text: "a" },
      { type: "ctx", text: "b" },
    ]);
  });

  it("marks every line added against an empty old text (new-skill mode)", () => {
    expect(diffLines("", "# Title\n\nBody")).toEqual([
      { type: "add", text: "# Title" },
      { type: "add", text: "" },
      { type: "add", text: "Body" },
    ]);
  });

  it("marks every line removed against an empty new text", () => {
    expect(diffLines("gone", "")).toEqual([{ type: "del", text: "gone" }]);
  });

  it("interleaves context, removals and additions for a mid-file edit", () => {
    expect(diffLines("a\nb\nc", "a\nx\nc")).toEqual([
      { type: "ctx", text: "a" },
      { type: "del", text: "b" },
      { type: "add", text: "x" },
      { type: "ctx", text: "c" },
    ]);
  });

  it("keeps a shared prefix when lines are appended", () => {
    expect(diffLines("a", "a\nb")).toEqual([
      { type: "ctx", text: "a" },
      { type: "add", text: "b" },
    ]);
  });

  it("keeps an interior empty line as a real added row", () => {
    expect(diffLines("a\n", "a\n\nb")).toEqual([
      { type: "ctx", text: "a" },
      { type: "add", text: "" },
      { type: "add", text: "b" },
    ]);
  });
});
