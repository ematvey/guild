import { describe, expect, it } from "vitest";
import { quantizeIso } from "./use-cached-api";

describe("quantizeIso", () => {
  it("buckets timestamps so repeated mounts share a cache key", () => {
    const t = Date.UTC(2026, 8, 13, 12, 34, 56, 789);
    const hour = 3600_000;
    const a = quantizeIso(hour, t);
    const b = quantizeIso(hour, t + 60_000);
    expect(a).toBe(b);
    expect(new Date(a).getTime()).toBeLessThanOrEqual(t);
  });

  it("different windows land in different buckets", () => {
    const day = 86_400_000;
    expect(quantizeIso(day, 0)).not.toBe(quantizeIso(day, day + 1));
  });

  it("emits a valid ISO string", () => {
    expect(new Date(quantizeIso(60_000, Date.now())).toString()).not.toBe("Invalid Date");
  });
});

// The usage endpoints filter with an inclusive upper bound; the UI's
// quantized `to` must therefore quantize UP, or events inside the current
// (partial) bucket are silently dropped from the charts.
describe("quantizeIso with a future timestamp", () => {
  it("reaches into the current bucket", () => {
    const granularity = 600_000;
    const now = Math.floor(Date.now() / granularity) * granularity + 1;
    const to = new Date(quantizeIso(granularity, now + granularity)).getTime();
    expect(to).toBeGreaterThan(now);
    // events at `now` pass an inclusive ts <= to filter
  });
});
