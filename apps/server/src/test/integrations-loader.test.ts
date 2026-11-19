// The plugin loader: built-ins keep their order, two plugins may not share a
// slug, and a manifest that breaks the contract is refused.

import { describe, expect, it } from "vitest";
import { mcpIntegration, type IntegrationPlugin, type McpIntegrationManifest } from "@guild/integration-sdk";
import { loadBuiltinMcp, loadBuiltins, validatePluginManifest } from "../integrations/loader.js";
import { firstSkill, indexDescription } from "../integrations/plugins.js";

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

function mcpPlugin(name: string, patch: Partial<McpIntegrationManifest> = {}) {
  return mcpIntegration({
    name,
    title: name,
    version: "1.0.0",
    publisher: "Test",
    summary: "test MCP server",
    description: "",
    docs_url: null,
    categories: [],
    fields: [{ name: "key", kind: "secret", label: "Key", required: true, default: null, help: null, placeholder: null }],
    mcp: { url: "https://mcp.example.test", headers: { Authorization: "Bearer {key}" }, envelope: false },
    ...patch,
  });
}

describe("loadBuiltinMcp", () => {
  it("serves MCP plugins as registry manifests and leaves them out of the connectors", () => {
    const plugins = [plugin("code"), mcpPlugin("remote", { tool_classes: { pay: "admin" } })];
    expect(loadBuiltins(plugins).map((c) => c.name)).toEqual(["code"]);
    const [remote] = loadBuiltinMcp(plugins);
    expect(remote!.manifest).toMatchObject({
      kind: "integration",
      slug: "remote",
      mcp: { url: "https://mcp.example.test", headers: { Authorization: "Bearer {key}" }, envelope: false },
      auth: { kind: "org_secret", secret_names: ["key"] },
      tools: { classes: { pay: "admin" } },
    });
    expect(remote!.manifest["runtime"]).toBeUndefined();
  });

  it("refuses a header template naming no secret field", () => {
    const bad = mcpPlugin("bad", { mcp: { url: "https://mcp.example.test", headers: { "X-Key": "{nope}" } } });
    expect(() => loadBuiltinMcp([bad])).toThrow(/names \{nope\}, which is no secret field/);
  });

  it("carries the skill slugs into the registry manifest", () => {
    const [remote] = loadBuiltinMcp([mcpPlugin("remote", { skills: ["remote-guide"] })]);
    expect(remote!.manifest["skills"]).toEqual(["remote-guide"]);
  });

  it("refuses a non-http server URL and a slug shared with a code plugin", () => {
    expect(() => loadBuiltinMcp([mcpPlugin("ftp", { mcp: { url: "ftp://x" } })])).toThrow(/mcp.url/);
    expect(() => loadBuiltinMcp([plugin("dup"), mcpPlugin("dup")])).toThrow(/two plugins declare this slug/);
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

  it("accepts the skill slugs that document an integration", () => {
    const p = plugin("x");
    p.manifest.skills = ["hubspot-analytics", "hubspot"];
    expect(() => validatePluginManifest(p.manifest)).not.toThrow();
    expect(firstSkill(p.manifest)).toBe("hubspot-analytics");
  });

  it("refuses a skill slug the registry could not hold", () => {
    const p = plugin("x");
    p.manifest.skills = ["Hubspot Analytics"];
    expect(() => validatePluginManifest(p.manifest)).toThrow(/skill slug/);
  });

  it("has no guide skill when the manifest names none", () => {
    expect(firstSkill(plugin("x").manifest)).toBeNull();
  });

  it("indexes an integration by its summary, one line", () => {
    expect(indexDescription({ summary: "HubSpot CRM\nsearch", description: "long prose" })).toBe("HubSpot CRM search");
    expect(indexDescription({ description: "v1 bundle\nonly prose" })).toBe("v1 bundle only prose");
    expect(indexDescription({ summary: "  " })).toBe("");
  });
});
