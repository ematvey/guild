// The plugin loader: built-ins keep their order, two plugins may not share a
// slug, and a manifest that breaks the contract is refused.

import { describe, expect, it } from "vitest";
import type { IntegrationPlugin } from "@guild/integration-sdk";
import { loadBuiltins, validatePluginManifest } from "../integrations/loader.js";

function plugin(name: string): IntegrationPlugin {
  return {
    manifest: {
      name,
      title: name,
      version: "1.0.0",
      publisher: "Test",
      summary: "test plugin",
      description: "",
      docs_url: null,
      categories: [],
      traits: {},
      auth_kind: "org_secret",
      identity_key: "email",
      fields: [],
      tools: [{ name: "ping", class: "read", description: "ping", parameters: { type: "object" } }],
    },
    async testConnection() {},
    async execute() {
      return { content: "pong" };
    },
  };
}

describe("loadBuiltins", () => {
  it("keeps the plugin order", () => {
    const loaded = loadBuiltins([plugin("first"), plugin("second")]);
    expect(loaded.map((i) => i.name)).toEqual(["first", "second"]);
    expect(loaded[0]!.origin).toBe("builtin");
  });

  it("refuses two plugins with one slug", () => {
    expect(() => loadBuiltins([plugin("searxng"), plugin("searxng")])).toThrow(/two plugins declare this slug/);
  });
});

describe("validatePluginManifest", () => {
  it("refuses a trait mapped to an undeclared tool", () => {
    const p = plugin("x");
    p.manifest.traits = { web_search: "missing" };
    expect(() => validatePluginManifest(p.manifest)).toThrow(/trait web_search names undeclared tool missing/);
  });

  it("refuses an unknown trait", () => {
    const p = plugin("x");
    p.manifest.traits = { teleport: "ping" };
    expect(() => validatePluginManifest(p.manifest)).toThrow(/unknown trait teleport/);
  });
});
