// @vitest-environment happy-dom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useTransient, useTransientFlag } from "./use-transient";

afterEach(() => vi.useRealTimers());

describe("useTransient", () => {
  it("falls back after the delay, restarting on every show", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTransientFlag(1500));
    act(() => result.current[1]());
    expect(result.current[0]).toBe(true);
    act(() => vi.advanceTimersByTime(1000));
    act(() => result.current[1]());
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current[0]).toBe(true);
    act(() => vi.advanceTimersByTime(500));
    expect(result.current[0]).toBe(false);
  });

  it("holds the shown value, and clears at once", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useTransient<string | null>(null, 100));
    act(() => result.current.show("approved"));
    act(() => result.current.hold());
    act(() => vi.advanceTimersByTime(500));
    expect(result.current.value).toBe("approved");
    act(() => result.current.clear());
    expect(result.current.value).toBeNull();
  });

  it("leaves no timer behind on unmount", () => {
    vi.useFakeTimers();
    const { result, unmount } = renderHook(() => useTransientFlag(1500));
    act(() => result.current[1]());
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
