import { describe, expect, it } from "vitest";
import { buildIntegrationConfig, initialDraft } from "../../../../control-center/src/integrations/configuration";
import type { FieldSpec } from "../../../../control-center/src/integrations/integrations-api";

const fields: FieldSpec[] = [
  { name: "api_key", kind: "secret", required: true },
  { name: "label", kind: "string", required: true },
  { name: "limit", kind: "number" },
  { name: "verbose", kind: "boolean" },
];

describe("integration config", () => {
  it.each([false, true])("never carries credentials (MCP=%s)", (isMcp) => {
    const stored = isMcp ? { mcp: { url: "https://old.test/mcp" }, api_key: "leak" } : { api_key: "leak", keep: 1 };
    const form = { ...initialDraft(fields, stored, isMcp), mcpUrl: "https://example.test/mcp" };
    form.draft = { ...form.draft, label: "changed" };
    const cfg = buildIntegrationConfig(fields, stored, form, isMcp);
    expect(cfg).toMatchObject({ label: "changed", verbose: false });
    expect(cfg).not.toHaveProperty("api_key");
    expect(cfg).not.toHaveProperty("limit");
    if (isMcp) expect(cfg.mcp).toEqual({ url: "https://example.test/mcp" });
    else expect(cfg.keep).toBe(1);
  });

  it("refuses a missing required value and bad advanced JSON", () => {
    const form = initialDraft(fields, {}, false);
    expect(() => buildIntegrationConfig(fields, {}, form, false)).toThrow("label is required");
    const mcp = { ...initialDraft(fields, { mcp: { url: "" } }, true), advancedText: "{" };
    mcp.draft = { ...mcp.draft, label: "x" };
    expect(() => buildIntegrationConfig(fields, { mcp: { url: "" } }, mcp, true)).toThrow("not valid JSON");
  });

  it("drops a stored role policy: access is the Integration's audience", () => {
    const form = initialDraft(fields, {}, false);
    form.draft = { ...form.draft, label: "x", limit: "5" };
    const cfg = buildIntegrationConfig(fields, { tool_policy: { admin: ["admin"] } }, form, false);
    expect(cfg.tool_policy).toBeUndefined();
    expect(cfg.limit).toBe(5);
  });
});
