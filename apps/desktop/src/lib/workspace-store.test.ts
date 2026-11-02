import { describe, expect, it } from "vitest";
import { applyWorkspaceIdentity, clearWorkspaceIdentity, runningWebBundle, webBundleOutdated } from "./workspace-store";
import { applyModelList, clearModelList, modelsSnapshot, seedModelList, subscribeModels } from "./models-store";

const page = (src: string | null) => ({
  querySelector: () => (src === null ? null : ({ getAttribute: () => src } as unknown as Element)),
});

describe("web bundle identity", () => {
  it("reads the running bundle from the entry script", () => {
    expect(runningWebBundle(page("/assets/index-Bx3k9aQd.js"))).toBe("Bx3k9aQd");
    expect(runningWebBundle(page(null))).toBeNull();
    expect(runningWebBundle(undefined)).toBeNull();
  });

  it("is outdated only when both sides are known and differ", () => {
    expect(webBundleOutdated("new", "old")).toBe(true);
    expect(webBundleOutdated("same", "same")).toBe(false);
    expect(webBundleOutdated(undefined, "old")).toBe(false);
    expect(webBundleOutdated("new", null)).toBe(false);
  });

  it("the identity store accepts a push and clears on sign-out", () => {
    applyWorkspaceIdentity({ name: "Acme", telemetry: true });
    clearWorkspaceIdentity();
  });
});

describe("model list store", () => {
  it("a push replaces the list; a seed never overwrites a pushed list", () => {
    clearModelList();
    let changes = 0;
    const off = subscribeModels(() => changes++);
    seedModelList([{ id: "seeded", alias: "" }]);
    expect(modelsSnapshot()).toEqual([{ id: "seeded", alias: "" }]);
    applyModelList([{ id: "pushed", alias: "Auto" }]);
    seedModelList([{ id: "stale", alias: "" }]);
    expect(modelsSnapshot()).toEqual([{ id: "pushed", alias: "Auto" }]);
    clearModelList();
    expect(modelsSnapshot()).toBeNull();
    off();
    expect(changes).toBe(3);
  });
});
