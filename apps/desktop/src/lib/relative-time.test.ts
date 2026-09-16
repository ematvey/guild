import { describe, expect, it } from "vitest";
import { relativeTime } from "./relative-time";

const NOW = Date.parse("2026-09-16T12:00:00Z");

describe("relativeTime", () => {
  it("renders sub-minute deltas as just now", () => {
    expect(relativeTime("2026-09-16T11:59:30Z", NOW)).toBe("just now");
    expect(relativeTime("2026-09-16T12:00:00Z", NOW)).toBe("just now");
  });

  it("renders minutes and hours", () => {
    expect(relativeTime("2026-09-16T11:55:00Z", NOW)).toBe("5m ago");
    expect(relativeTime("2026-09-16T09:00:00Z", NOW)).toBe("3h ago");
  });

  it("renders days", () => {
    expect(relativeTime("2026-09-14T12:00:00Z", NOW)).toBe("2d ago");
  });

  it("clamps future timestamps to just now", () => {
    expect(relativeTime("2026-09-16T12:05:00Z", NOW)).toBe("just now");
  });

  it("returns empty for unparseable input", () => {
    expect(relativeTime("not-a-date", NOW)).toBe("");
  });
});
