import { describe, expect, it } from "vitest";
import { threadTitleFromMessage } from "./thread-title";

describe("threadTitleFromMessage", () => {
  it("uses the first non-empty line and strips markdown", () => {
    expect(threadTitleFromMessage("  # Plan the launch  \nsecond line")).toBe("Plan the launch");
    expect(threadTitleFromMessage("- fix the [flaky](https://x) test")).toBe("Fix the flaky test");
  });

  it("keeps short messages whole and capitalizes the first letter", () => {
    expect(threadTitleFromMessage("oi mate")).toBe("Oi mate");
    expect(threadTitleFromMessage("")).toBe("");
  });

  it("cuts at six words with an ellipsis instead of mid-word", () => {
    // Regression: the composer sent the raw first 48 characters, so titles
    // ended mid-word ("...thread title as").
    expect(
      threadTitleFromMessage("auto name test: please check the thread title assignment now"),
    ).toBe("Auto name test: please check the…");
  });

  it("bounds a long single word at the character cap", () => {
    const title = threadTitleFromMessage("oneverylongwordwithoutspaces".repeat(3));
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith("…")).toBe(true);
  });
});
