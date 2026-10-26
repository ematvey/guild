import { describe, expect, it } from "vitest";
import {
  cacheEpochChanged,
  clearSettingsCaches,
  currentCacheEpoch,
  peekCached,
} from "../views/settings/use-cached-api";

// The epoch contract every module cache relies on: a response that lands
// after a clear (sign-out) is stale and must not repopulate the cache for
// the next account.
describe("cache epoch guard", () => {
  it("marks in-flight responses stale across a clear", () => {
    const epoch = currentCacheEpoch();
    expect(cacheEpochChanged(epoch)).toBe(false);

    // Account A's GET is in flight when the user signs out.
    clearSettingsCaches();
    expect(cacheEpochChanged(epoch)).toBe(true);

    // A lands after the clear: dropped, cache stays empty for account B.
    // (The writer checks cacheEpochChanged(epoch) before cache.set.)
    expect(peekCached("/api/v1/gateway/keys")).toBeUndefined();

    // Account B's own requests capture the new epoch and write normally.
    const epochB = currentCacheEpoch();
    expect(cacheEpochChanged(epochB)).toBe(false);
    clearSettingsCaches();
    expect(cacheEpochChanged(epochB)).toBe(true);
  });
});
