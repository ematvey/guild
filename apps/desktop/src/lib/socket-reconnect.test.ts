import { describe, expect, it } from "vitest";
import { reconnectDelayMs } from "./socket-client";

describe("reconnectDelayMs", () => {
  it("grows exponentially to a 30 s cap with full jitter", () => {
    expect(reconnectDelayMs(0, 0.999)).toBeLessThan(1_000);
    expect(reconnectDelayMs(3, 0.999)).toBeLessThan(8_000);
    expect(reconnectDelayMs(3, 0.999)).toBeGreaterThan(7_000);
    expect(reconnectDelayMs(50, 0.999)).toBeLessThan(30_000);
    expect(reconnectDelayMs(50, 0.999)).toBeGreaterThan(29_000);
  });

  it("never redials faster than 250 ms", () => {
    expect(reconnectDelayMs(0, 0)).toBe(250);
  });
});
