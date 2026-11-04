/// <reference types="vite/client" />
import gatewaySource from "./GatewaySection.tsx?raw";
import deviceSetupSource from "../../device-setup.tsx?raw";
import { describe, expect, it, vi } from "vitest";

// Execute the production closures with controlled state and deferred transport.
// This keeps the regression focused without requiring a browser renderer.
function source(file: string, start: string, end: string): string {
  const text = file.includes("GatewaySection") ? gatewaySource : "";
  return text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
}

describe("round 3 API key cache", () => {
  it("ignores a creation response after sign-out", async () => {
    const code = source("./GatewaySection.tsx", "  async function create()", "  async function revoke()");
    let epoch = 0;
    let resolve!: (result: unknown) => void;
    const response = new Promise((done) => {
      resolve = done;
    });
    const setKeys = vi.fn();
    const create = new Function(
      "createMyApiKey",
      "currentCacheEpoch",
      "cacheEpochChanged",
      "setKeys",
      `
      let lastKeys = null;
      const name = 'private';
      const toast = { error() {}, success() {} };
      const setIssued = () => {}, setCreating = () => {}, setName = () => {};
      ${code}
      return { create, cached: () => lastKeys };
    `,
    )(
      () => response,
      () => epoch,
      (old: number) => old !== epoch,
      setKeys,
    );
    const pending = create.create();
    epoch++;
    resolve({ key: { id: "A-private-key" }, plaintext: "secret" });
    await pending;
    expect(create.cached()).toBeNull();
    expect(setKeys).not.toHaveBeenCalled();
  });
});

describe("round 3 device installers", () => {
  it("keeps both Mac DMGs and excludes updater archives", () => {
    const start = deviceSetupSource.indexOf("  const installers =");
    const code = deviceSetupSource.slice(start, deviceSetupSource.indexOf("  const generatePairing =", start));
    const select = new Function("releases", "os", "OS_KEY", `${code}; return installers;`);
    const releases = ["darwin-aarch64", "darwin-x86_64"].flatMap((platform) =>
      ["Guild.dmg", "Guild.app.tar.gz"].map((filename) => ({ platform, filename })),
    );
    expect(select(releases, "mac", { mac: "darwin" })).toEqual(releases.filter((row) => row.filename.endsWith(".dmg")));
    expect(select(null, "mac", { mac: "darwin" })).toBeNull();
  });
});
