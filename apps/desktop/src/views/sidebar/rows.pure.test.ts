import { describe, expect, it } from "vitest";
import { rowIndicator } from "./rows";

describe("rowIndicator", () => {
  it("puts a blocked tool call above every other state", () => {
    expect(rowIndicator({ generating: true, working: true, unread: true, blocked: true })).toBe("blocked");
  });

  it("keeps the working spinner above the unread dot", () => {
    expect(rowIndicator({ generating: true, unread: true })).toBe("working");
    expect(rowIndicator({ generating: false, working: true, unread: true })).toBe("working");
  });

  it("shows the unread dot only when nothing else applies", () => {
    expect(rowIndicator({ generating: false, unread: true })).toBe("unread");
    expect(rowIndicator({ generating: false, unread: false })).toBeNull();
  });
});
