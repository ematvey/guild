// @vitest-environment happy-dom
// The preview pane's width: the clamp and the storage round-trip. The drag
// itself is a pointer gesture the pane test exercises through the handle.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampPreviewWidth,
  PREVIEW_DEFAULT_W,
  PREVIEW_MAX_W,
  PREVIEW_MIN_W,
  PREVIEW_WIDTH_KEY,
  savePreviewWidth,
  storedPreviewWidth,
} from "./preview";

function store(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
}

describe("preview width", () => {
  beforeEach(() => vi.stubGlobal("localStorage", store()));

  it("clamps to the pane's floor and cap", () => {
    expect(clampPreviewWidth(100)).toBe(PREVIEW_MIN_W);
    expect(clampPreviewWidth(PREVIEW_MAX_W + 200)).toBe(PREVIEW_MAX_W);
    expect(clampPreviewWidth(600)).toBe(600);
  });

  it("defaults with nothing stored", () => {
    expect(storedPreviewWidth()).toBe(PREVIEW_DEFAULT_W);
  });

  it("saves and reads back the width, clamped", () => {
    savePreviewWidth(700);
    expect(localStorage.getItem(PREVIEW_WIDTH_KEY)).toBe("700");
    expect(storedPreviewWidth()).toBe(700);

    localStorage.setItem(PREVIEW_WIDTH_KEY, "100");
    expect(storedPreviewWidth()).toBe(PREVIEW_MIN_W);
  });
});
