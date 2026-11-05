// A tool result's images are a display copy of what the durable entry
// already holds, so they obey the same threshold as its text: past it the
// event drops them instead of carrying megabytes of base64 into every
// ThreadState frame (one prod thread shipped 6.7 MB of PNG per frame).

import { describe, expect, it } from "vitest";
import { imagesFitInline, SPILL_THRESHOLD_BYTES } from "../chats/spill.js";

const image = (bytes: number): string => `data:image/png;base64,${"A".repeat(bytes)}`;

describe("imagesFitInline", () => {
  it("keeps small images inline", () => {
    expect(imagesFitInline([image(1_000), image(2_000)])).toBe(true);
  });

  it("rejects a single image past the threshold", () => {
    expect(imagesFitInline([image(SPILL_THRESHOLD_BYTES)])).toBe(false);
  });

  it("rejects a set that only exceeds the threshold together", () => {
    const half = Math.floor(SPILL_THRESHOLD_BYTES / 2) + 10;
    expect(imagesFitInline([image(half)])).toBe(true);
    expect(imagesFitInline([image(half), image(half)])).toBe(false);
  });

  it("keeps an empty set inline", () => {
    expect(imagesFitInline([])).toBe(true);
  });
});
