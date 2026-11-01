// The device side of Web Push: what this build can promise. The browser
// behaviours (permission prompts, subscriptions) need a real browser; these
// pin the pure parts the UI branches on.

import { describe, expect, it } from "vitest";
import { deviceId, pushBlocker, urlBase64ToUint8Array } from "./push";

describe("pushBlocker", () => {
  it("reports unsupported where there is no browser at all", () => {
    // Node: no window, so no service worker and no push manager.
    expect(pushBlocker()).toBe("unsupported");
  });
});

describe("urlBase64ToUint8Array", () => {
  it("decodes the base64url a VAPID key arrives in", () => {
    // "hello" in base64url has no padding and no +/ characters.
    expect(Array.from(urlBase64ToUint8Array("aGVsbG8"))).toEqual([104, 101, 108, 108, 111]);
  });

  it("accepts the URL-safe alphabet and missing padding", () => {
    // 0xfb 0xff -> "-_8" in base64url.
    expect(Array.from(urlBase64ToUint8Array("-_8"))).toEqual([251, 255]);
  });
});

describe("deviceId", () => {
  it("is stable per install and survives a missing localStorage", () => {
    // Node has no localStorage: the id degrades instead of throwing.
    expect(deviceId()).toBe("unknown");
    expect(deviceId()).toBe("unknown");
  });
});
