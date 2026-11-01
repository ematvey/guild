// @vitest-environment happy-dom
// General and About read the pushed workspace identity: the name field fills
// when the first identity lands (a direct load) without clobbering an edit,
// and About's telemetry line follows the pushed switch.
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
import GeneralSection, { followPushedName } from "./GeneralSection";
import { AboutSection } from "./AboutSection";

function identity(name: string, telemetry: boolean): WorkspaceIdentity {
  return { name, logo_url: null, telemetry } as WorkspaceIdentity;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("offline"))));
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
  it("shows the pushed telemetry switch and follows it", () => {
    render(<AboutSection />);
    expect(screen.queryByText(/^On —|^Off —/)).toBeNull();
    act(() => applyWorkspaceIdentity(identity("w", true)));
    expect(screen.getByText(/^On —/)).toBeTruthy();
    act(() => applyWorkspaceIdentity(identity("w", false)));
    expect(screen.getByText(/^Off —/)).toBeTruthy();
  });
});
