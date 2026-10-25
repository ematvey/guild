import { afterEach, describe, expect, it, vi } from "vitest";

describe("settings reads distinguish failures from defaults", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["getApproval", "getAssistantPrompt"] as const)("%s rejects failed reads", async (name) => {
    const transport = await import("./approvals");
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unavailable", { status: 503 })));
    await expect(transport[name]()).rejects.toThrow("503");
  });

  it("preserves a successful absent assistant override and the effective default", async () => {
    const { getAssistantPrompt } = await import("./approvals");
    vi.stubGlobal("localStorage", { getItem: () => null });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ prompt: null, default: "You are a helpful assistant." }), {
          status: 200,
        }),
      ),
    );
    await expect(getAssistantPrompt()).resolves.toEqual({
      prompt: null,
      default: "You are a helpful assistant.",
    });
  });
});
