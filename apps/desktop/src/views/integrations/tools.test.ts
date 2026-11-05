import { describe, expect, it } from "vitest";
import { toolOn } from "./tools";

describe("toolOn", () => {
  it("reads an unset tool as on; only an explicit false is off", () => {
    expect(toolOn({})).toBe(true);
    expect(toolOn({ enabled: undefined })).toBe(true);
    expect(toolOn({ enabled: true })).toBe(true);
    expect(toolOn({ enabled: false })).toBe(false);
  });
});
