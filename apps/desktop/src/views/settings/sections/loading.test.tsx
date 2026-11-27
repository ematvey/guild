import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import GeneralSection from "../../../../../control-center/src/settings/GeneralSection";
import { AssistantSection } from "../../../../../control-center/src/settings/AssistantSection";
import { AboutSection } from "./AboutSection";

vi.mock("../../../lib/session", () => ({
  HAS_SHELL: false,
  HAS_ENGINE: false,
  apiUrl: (path: string) => path,
  serverUrl: () => "http://localhost:18080",
  serverBase: () => "",
}));
vi.mock("../../../lib/api/approvals", () => ({
  getApproval: vi.fn(),
  setApproval: vi.fn(),
  getAssistantPrompt: vi.fn(),
  setAssistantPrompt: vi.fn(),
  getApprovalPolicyPrompt: vi.fn(),
  setApprovalPolicyPrompt: vi.fn(),
}));
vi.mock("../../../lib/telemetry", () => ({
  traceEvent: vi.fn(),
  applyTelemetrySetting: vi.fn(),
  telemetryEnabled: () => true,
}));

describe("first paint before settings requests resolve", () => {
  it("does not claim the workspace has no logo or offer an editable empty name", () => {
    const html = renderToStaticMarkup(<GeneralSection />);
    expect(html).toContain("Loading workspace name");
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain("no logo");
    expect(html).not.toContain('id="workspace-name"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>/);
  });

  it("does not describe unread prompts as defaults", () => {
    const html = renderToStaticMarkup(<AssistantSection />);
    expect(html).toContain("Loading content");
    expect(html).not.toContain("(default)");
    expect(html).not.toContain("Currently using the default");
    expect(html).not.toContain("<textarea");
  });

  it("does not claim no desktop release exists before checking the manifest", () => {
    const html = renderToStaticMarkup(<AboutSection />);
    expect(html).toContain('data-slot="skeleton"');
    expect(html).not.toContain(">none<");
    expect(html).not.toContain("Unavailable");
  });
});
