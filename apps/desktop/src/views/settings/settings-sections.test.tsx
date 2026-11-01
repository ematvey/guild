// @vitest-environment happy-dom
// An admin section opened by a member's address renders the default section
// instead, so none of the admin section's requests leave the client.
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../lib/session", () => ({
  HAS_SHELL: false,
  HAS_ENGINE: false,
  apiUrl: (path: string) => path,
  serverUrl: () => "http://localhost:18080",
  serverBase: () => "",
  getToken: () => null,
  refreshSession: async () => false,
}));

import { DEFAULT_USAGE } from "./usage-route";
import { SETTINGS_SECTIONS, SettingsSectionPane } from "./settings-sections";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function adminRequests(): string[] {
  return fetchMock.mock.calls
    .map(([input]) => String(input instanceof Request ? input.url : input))
    .filter((url) => url.includes("/admin/"));
}

function pane(sectionId: string, role: string) {
  return render(
    <SettingsSectionPane
      sectionId={sectionId}
      email="m@example.com"
      role={role}
      detail={null}
      onDetailChange={() => {}}
      usage={DEFAULT_USAGE}
      onUsageChange={() => {}}
    />,
  );
}

describe("SettingsSectionPane", () => {
  it("never renders an admin section for a member, so it issues no admin request", async () => {
    for (const section of ["users", "models", "general"]) {
      pane(section, "member");
      cleanup();
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(adminRequests()).toEqual([]);
  });

  it("renders the admin section for an admin", async () => {
    pane("users", "admin");
    await new Promise((r) => setTimeout(r, 0));
    expect(adminRequests().some((url) => url.includes("/admin/users"))).toBe(true);
  });

  it("marks every workspace section admin-only", () => {
    expect(SETTINGS_SECTIONS.filter((s) => s.group === "workspace").every((s) => s.admin)).toBe(true);
    expect(SETTINGS_SECTIONS.filter((s) => s.group === "user").some((s) => s.admin)).toBe(false);
  });
});
