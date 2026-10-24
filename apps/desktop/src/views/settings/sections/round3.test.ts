/// <reference types="vite/client" />
import integrationSource from "./IntegrationsSection.tsx?raw";
import gatewaySource from "./GatewaySection.tsx?raw";
import deviceSetupSource from "../../thread/device-setup.tsx?raw";
import { transpile } from "typescript";
import { describe, expect, it, vi } from "vitest";

// Execute the production closures with controlled state and deferred transport.
// This keeps the regression focused without requiring a browser renderer.
function source(file: string, start: string, end: string): string {
  const text = file.includes("IntegrationsSection") ? integrationSource : gatewaySource;
  return text.slice(text.indexOf(start), text.indexOf(end, text.indexOf(start)));
}

describe("round 3 integration config", () => {
  it.each([false, true])("excludes required secrets with MCP=%s", (isMcp) => {
    const code = transpile(source("./IntegrationsSection.tsx", "  const buildConfig =", "  const save ="));
    const build = new Function("isMcp", "advancedText", "initialConfig", "mcpUrl", "fields", "draft", "policy", "cleanPolicy", "fieldLabel", `${code}; return buildConfig;`)(
      isMcp, "{}", {}, "https://example.test/mcp",
      [{ name: "api_key", kind: "secret", required: true }, { name: "label", kind: "string", required: true }],
      { label: "changed" }, {}, () => ({}), (field: { name: string }) => field.name,
    );
    // New credentials and retained stored credentials both bypass ordinary config.
    expect(build()).toMatchObject({ label: "changed" });
    expect(build()).not.toHaveProperty("api_key");
  });
});

describe("round 3 API key cache", () => {
  it("ignores a creation response after sign-out", async () => {
    const code = source("./GatewaySection.tsx", "  async function create()", "  async function revoke()");
    let epoch = 0;
    let resolve!: (result: unknown) => void;
    const response = new Promise((done) => { resolve = done; });
    const setKeys = vi.fn();
    const create = new Function("createMyApiKey", "currentCacheEpoch", "cacheEpochChanged", "setKeys", `
      let lastKeys = null;
      const name = 'private';
      const toast = { error() {}, success() {} };
      const setIssued = () => {}, setCreating = () => {}, setName = () => {};
      ${code}
      return { create, cached: () => lastKeys };
    `)(() => response, () => epoch, (old: number) => old !== epoch, setKeys);
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
