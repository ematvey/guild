// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  status: { channel: "stable", phase: "idle", pending_version: null as string | null, message: null as string | null },
  listeners: new Set<(event: { payload: unknown }) => void>(),
  invoke: vi.fn(),
  failSave: false,
}));
vi.mock("../../../lib/session", () => ({
  HAS_SHELL: true,
  serverBase: () => "http://localhost:18080",
  serverUrl: () => "http://localhost:18080",
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("0.6.126") }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_: string, listener: (event: { payload: unknown }) => void) => {
    native.listeners.add(listener);
    return Promise.resolve(() => native.listeners.delete(listener));
  },
}));
import { AboutSection } from "./AboutSection";
import { applyWorkspaceIdentity, clearWorkspaceIdentity } from "../../../lib/workspace-store";

function push() {
  for (const listener of native.listeners) listener({ payload: { ...native.status } });
}
beforeEach(() => {
  native.status = { channel: "stable", phase: "idle", pending_version: null, message: null };
  native.failSave = false;
  native.invoke.mockReset().mockImplementation((command: string, args?: { channel: string }) => {
    if (command === "update_status") return Promise.resolve({ ...native.status });
    if (command === "set_update_channel") {
      if (native.failSave) return Promise.reject(new Error("permission denied"));
      native.status = { ...native.status, channel: args!.channel, pending_version: null, phase: "idle" };
      push();
      return Promise.resolve({ ...native.status });
    }
    if (command === "daemon_trace_state")
      return Promise.resolve({ enabled: false, path: "/home/user/.cache/guild/trace.log" });
    return Promise.resolve();
  });
  applyWorkspaceIdentity({ name: "Workspace", telemetry: false, server_version: "0.6.127-dev.200" });
});
afterEach(() => {
  cleanup();
  native.listeners.clear();
  clearWorkspaceIdentity();
});

describe("installation update channel", () => {
  it("changes the native preference, clears the old offer, and restores the selection on remount", async () => {
    native.status = { ...native.status, phase: "ready", pending_version: "0.6.127" };
    const first = render(<AboutSection />);
    await waitFor(() => expect((screen.getByLabelText("Update channel") as HTMLSelectElement).value).toBe("stable"));
    expect(screen.getByText("Version 0.6.127 is ready to install.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Update channel"), { target: { value: "develop" } });
    await waitFor(() => expect((screen.getByLabelText("Update channel") as HTMLSelectElement).value).toBe("develop"));
    expect(native.invoke).toHaveBeenCalledWith("set_update_channel", { channel: "develop" });
    expect(screen.queryByText("Version 0.6.127 is ready to install.")).toBeNull();
    first.unmount();
    render(<AboutSection />);
    await waitFor(() => expect((screen.getByLabelText("Update channel") as HTMLSelectElement).value).toBe("develop"));
  });
  it("keeps the saved channel and shows an error when persistence fails", async () => {
    render(<AboutSection />);
    await waitFor(() => expect((screen.getByLabelText("Update channel") as HTMLSelectElement).value).toBe("stable"));
    native.failSave = true;
    fireEvent.change(screen.getByLabelText("Update channel"), { target: { value: "develop" } });
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Could not save"));
    expect((screen.getByLabelText("Update channel") as HTMLSelectElement).value).toBe("stable");
  });
  it("a pushed channel change wins over an older initial native snapshot", async () => {
    let resolve!: (value: unknown) => void;
    native.invoke.mockImplementation((command: string) =>
      command === "update_status"
        ? new Promise((r) => {
            resolve = r;
          })
        : Promise.resolve(null),
    );
    render(<AboutSection />);
    await waitFor(() => expect(resolve).toBeTypeOf("function"));
    await act(async () => {
      native.status.channel = "develop";
      push();
      resolve({ channel: "stable", phase: "idle", pending_version: null, message: null });
    });
    expect((screen.getByLabelText("Update channel") as HTMLSelectElement).value).toBe("develop");
  });
});
