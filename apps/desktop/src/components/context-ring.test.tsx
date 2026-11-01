// @vitest-environment happy-dom
// The context meter reads the pushed usage and the pushed model list: it
// never fetches, and a frame repaints it.
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyContextUsage, clearContextUsage } from "../lib/context-usage-store";
import { applyModelList, clearModelList } from "../lib/models-store";
import { ContextRing } from "./context-ring";

const label = (container: HTMLElement) =>
  container.querySelector("[data-context-ring]")?.getAttribute("aria-label") ?? "";

describe("ContextRing", () => {
  afterEach(() => {
    clearContextUsage();
    clearModelList();
    vi.unstubAllGlobals();
  });

  it("paints the pushed usage over the selected model's window without a request", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    applyModelList([{ id: "m", alias: "Model", context_window: 10_000 }]);
    const { container } = render(<ContextRing chatId="c1" model="m" />);
    expect(label(container)).toBe("Loading context usage");

    act(() => applyContextUsage("c1", { tokens: 2_500, usage_model: "m", usage_model_alias: "Model" }));
    expect(label(container)).toBe("Context: ~2.5K / 10K tokens (25%). Last completed request, including its response.");

    act(() => applyContextUsage("c1", { tokens: null, usage_model: null, usage_model_alias: null }));
    expect(label(container)).toBe("Context usage available after the next response");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("names the measuring model when it differs from the selected one", () => {
    applyModelList([
      { id: "m", alias: "Model", context_window: 10_000 },
      { id: "n", alias: "Other", context_window: 20_000 },
    ]);
    applyContextUsage("c1", { tokens: 5_000, usage_model: "m", usage_model_alias: "Model" });
    const { container } = render(<ContextRing chatId="c1" model="n" />);
    expect(label(container)).toContain("5K / 20K tokens (25%)");
    expect(label(container)).toContain("measured on Model");
  });
});
