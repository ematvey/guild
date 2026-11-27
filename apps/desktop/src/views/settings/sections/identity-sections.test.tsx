// @vitest-environment happy-dom
// General and About read the pushed workspace identity: the name field fills
// when the first identity lands without clobbering an edit,
// and About follows the server version.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../lib/session", () => ({
  HAS_SHELL: false,
  HAS_ENGINE: false,
  apiUrl: (path: string) => path,
  serverUrl: () => "http://localhost:18080",
  serverBase: () => "",
}));

import { applyWorkspaceIdentity, clearWorkspaceIdentity, type WorkspaceIdentity } from "../../../lib/workspace-store";
import GeneralSection, { followPushedName } from "../../../../../control-center/src/settings/GeneralSection";
import { AboutSection } from "./AboutSection";

function identity(name: string, telemetry: boolean): WorkspaceIdentity {
  return { name, telemetry };
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.reject(new Error("offline"))),
  );
});

afterEach(() => {
  cleanup();
  clearWorkspaceIdentity();
  vi.unstubAllGlobals();
});

describe("General", () => {
  it("follows the pushed name unless the admin edited away from it", () => {
    expect(followPushedName("", null, "Acme (dev)")).toBe("Acme (dev)");
    expect(followPushedName("Old", "Old", "New")).toBe("New");
    expect(followPushedName("Draft", "Old", "New")).toBe("Draft");
  });

  it("fills the name field when the first identity lands after mount", () => {
    render(<GeneralSection />);
    expect(screen.queryByRole("textbox", { name: "Workspace name" })).toBeNull();
    act(() => applyWorkspaceIdentity(identity("Acme (dev)", true)));
    const field = screen.getByRole("textbox", { name: "Workspace name" }) as HTMLInputElement;
    expect(field.value).toBe("Acme (dev)");

    fireEvent.change(field, { target: { value: "My draft" } });
    act(() => applyWorkspaceIdentity(identity("Renamed elsewhere", true)));
    expect(field.value).toBe("My draft");
  });
});

describe("About", () => {
  it("shows the pushed server version without telemetry details", () => {
    render(<AboutSection />);
    act(() => applyWorkspaceIdentity({ ...identity("Workspace", true), server_version: "0.7.9" }));
    expect(screen.getAllByText("0.7.9")).toHaveLength(2);
    expect(screen.queryByText("Telemetry")).toBeNull();
  });
});
