import { describe, expect, it } from "vitest";
import { windowTitle } from "./window-title";

describe("windowTitle", () => {
  it("puts the workspace name before the app name", () => {
    expect(windowTitle("Acme")).toBe("Acme - Guild");
  });

  it("falls back to the app name for an unnamed workspace", () => {
    expect(windowTitle("")).toBe("Guild");
    expect(windowTitle("   ")).toBe("Guild");
    expect(windowTitle(null)).toBe("Guild");
    expect(windowTitle(undefined)).toBe("Guild");
  });

  it("trims the name", () => {
    expect(windowTitle("  Acme  ")).toBe("Acme - Guild");
  });
});
