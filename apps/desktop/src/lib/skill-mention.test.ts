// Pure-logic tests for the composer's skill-mention detection.

import { describe, expect, it } from "vitest";
import { applyMention, detectMention } from "./skill-mention";

describe("detectMention", () => {
  it("opens on / at text start", () => {
    expect(detectMention("/", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(detectMention("/deploy-check", 13)).toEqual({
      start: 0,
      end: 13,
      query: "deploy-check",
    });
  });

  it("opens on / after whitespace", () => {
    expect(detectMention("use /dep", 8)).toEqual({ start: 4, end: 8, query: "dep" });
    expect(detectMention("line\n/review", 12)).toEqual({ start: 5, end: 12, query: "review" });
  });

  it("stays closed for URLs, paths, and mid-word slashes", () => {
    expect(detectMention("https://dep", 11)).toBeNull();
    expect(detectMention("see a/b", 7)).toBeNull();
    expect(detectMention("mid/deploy", 10)).toBeNull();
    expect(detectMention("run /usr/bin/ls", 15)).toBeNull();
  });

  it("stays closed when the caret is not inside a token", () => {
    expect(detectMention("/deploy done", 12)).toBeNull();
    expect(detectMention("plain text", 10)).toBeNull();
  });
});

describe("applyMention", () => {
  it("replaces the open token with the picked skill", () => {
    const r = applyMention("use /dep", 8, "deploy-check");
    expect(r.text).toBe("use /deploy-check ");
    expect(r.caret).toBe(18);
  });

  it("replaces a bare /", () => {
    const r = applyMention("/", 1, "review");
    expect(r.text).toBe("/review ");
  });

  it("replaces a mid-text token after its full fragment", () => {
    const r = applyMention("do it /rev now", 10, "review");
    expect(r.text).toBe("do it /review  now");
    expect(r.caret).toBe("do it /review ".length);
  });
});
