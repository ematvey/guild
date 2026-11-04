// The plugin loader: sources keep their order, logos come from each
// plugin's own folder, and two plugins may not share a slug.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { loadIntegrations } from "../integrations/loader.js";
import type { IntegrationPlugin } from "../integrations/sdk.js";

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

describe("loadIntegrations", () => {
  it("keeps source order and reads each logo from the plugin folder", () => {
    const root = mkdtempSync(join(tmpdir(), "guild-plugins-"));
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "logo.svg"), "<svg/>");
    mkdirSync(join(root, "b"));
    const loaded = loadIntegrations([
      { plugin: plugin("first"), dir: pathToFileURL(join(root, "a") + "/") },
      { plugin: plugin("second"), dir: pathToFileURL(join(root, "b") + "/") },
    ]);
    expect(loaded.map((i) => i.name)).toEqual(["first", "second"]);
    expect(loaded[0]!.logo).toBe("<svg/>");
    expect(loaded[1]!.logo).toBe("");
  });

  it("refuses two plugins with one slug", () => {
    const dir = pathToFileURL(tmpdir() + "/");
    expect(() =>
      loadIntegrations([
        { plugin: plugin("searxng"), dir },
        { plugin: plugin("searxng"), dir },
      ]),
    ).toThrow(/two plugins declare this slug/);
  });
});
