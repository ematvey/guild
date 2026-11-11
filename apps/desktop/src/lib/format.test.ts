import { describe, expect, it } from "vitest";
import { formatBytes, formatDuration } from "./format";

describe("formatBytes", () => {
  it("rounds to one decimal below ten units, whole numbers above", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(20 * 1024)).toBe("20 KB");
    expect(formatBytes(2 * 1024 * 1024)).toBe("2.0 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  });

  it("reports a missing size as a dash", () => {
    expect(formatBytes(null)).toBe("—");
    expect(formatBytes(undefined)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });

  it("uses binary units when asked", () => {
    expect(formatBytes(1536, { binary: true })).toBe("1.5 KiB");
    expect(formatBytes(12.3 * 1024 * 1024, { binary: true })).toBe("12 MiB");
  });
});

describe("formatDuration", () => {
  it("drops the units above the largest non-zero one", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(7)).toBe("7s");
    expect(formatDuration(75)).toBe("1m 15s");
    expect(formatDuration(3600)).toBe("1h 0m 0s");
    expect(formatDuration(3900 + 5)).toBe("1h 5m 5s");
  });

  it("keeps the units below the largest one, down to the second", () => {
    expect(formatDuration(86_400 + 3661)).toBe("1d 1h 1m 1s");
    expect(formatDuration(120)).toBe("2m 0s");
  });

  it("floors fractional seconds and clamps negatives", () => {
    expect(formatDuration(9.9)).toBe("9s");
    expect(formatDuration(-4)).toBe("0s");
  });
});
