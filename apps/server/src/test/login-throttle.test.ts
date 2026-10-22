import { describe, expect, it } from "vitest";
import { FailureWindow } from "../platform/http/login-throttle.js";

describe("FailureWindow", () => {
  it("blocks after the configured number of failures", () => {
    const window = new FailureWindow(60_000, 3);
    const key = "email:a@example.org";
    const now = 1_000_000;
    expect(window.isLimited(key, now)).toBe(false);
    window.recordFailure(key, now);
    window.recordFailure(key, now);
    expect(window.isLimited(key, now)).toBe(false);
    window.recordFailure(key, now);
    expect(window.isLimited(key, now)).toBe(true);
  });

  it("frees the key once the oldest failure leaves the window", () => {
    const window = new FailureWindow(60_000, 2);
    const key = "email:a@example.org";
    window.recordFailure(key, 0);
    window.recordFailure(key, 1_000);
    expect(window.isLimited(key, 2_000)).toBe(true);
    // At 60_001 the first failure is outside the window; one remains.
    expect(window.isLimited(key, 60_001)).toBe(false);
    expect(window.retryAfterSeconds(key, 60_001)).toBe(1);
  });

  it("reset clears the key", () => {
    const window = new FailureWindow(60_000, 1);
    const key = "email:a@example.org";
    window.recordFailure(key, 0);
    expect(window.isLimited(key, 1)).toBe(true);
    window.reset(key);
    expect(window.isLimited(key, 1)).toBe(false);
    expect(window.retryAfterSeconds(key, 1)).toBe(0);
  });

  it("does not leak expired keys", () => {
    const window = new FailureWindow(1_000, 5);
    window.recordFailure("email:old@example.org", 0);
    expect(window.count("email:old@example.org", 2_000)).toBe(0);
  });

  it("caps the number of tracked keys", () => {
    const window = new FailureWindow(60_000, 5);
    for (let i = 0; i < 10_050; i += 1) {
      window.recordFailure(`email:user${i}@example.org`, 1_000);
    }
    // The newest keys survive; the map stays bounded.
    expect(window.count("email:user10049@example.org", 1_000)).toBe(1);
    expect(window.count("email:user0@example.org", 1_000)).toBe(0);
  });
});
