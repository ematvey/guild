import { describe, expect, it } from "vitest";
import { cleanGeneratedTitle, resolveGeneratedTitle } from "../../harness/title.js";

describe("cleanGeneratedTitle", () => {
  it("uses the first line and strips wrappers a chat model adds", () => {
    expect(cleanGeneratedTitle('"Fix the flaky sandbox tests"')).toBe("Fix the flaky sandbox tests");
    expect(cleanGeneratedTitle("Title: Fix the flaky sandbox tests.")).toBe("Fix the flaky sandbox tests");
    expect(cleanGeneratedTitle("\n  Plan the launch  \nignored")).toBe("Plan the launch");
  });

  it("bounds the model's reply to the same short label as the fallback", () => {
    expect(cleanGeneratedTitle("A very long generated name that runs past the cap for sure")).toBe(
      "A very long generated name that…",
    );
    expect(cleanGeneratedTitle("")).toBe("");
    expect(cleanGeneratedTitle("   ")).toBe("");
  });
});

describe("resolveGeneratedTitle", () => {
  it("uses the model's title when it produced one", () => {
    expect(resolveGeneratedTitle("Продовольствие в ОАЭ", "почему цены выросли")).toBe(
      "Продовольствие в ОАЭ",
    );
  });

  it("names the thread from the first message when the reply is empty", () => {
    expect(resolveGeneratedTitle("", "почему цены на продовольствие не особо выросли")).toBe(
      "Почему цены на продовольствие не особо…",
    );
    expect(resolveGeneratedTitle("   ", "")).toBe("");
  });
});
