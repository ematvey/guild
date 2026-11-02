// @vitest-environment happy-dom
// A failed activity read says so and keeps the rows already shown.
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SkillActivityEvent } from "./skills-api";

const api = vi.hoisted(() => ({ skillsActivity: vi.fn() }));
vi.mock("./skills-api", async (importOriginal) => ({ ...(await importOriginal<object>()), ...api }));

import { ActivityFeed } from "./ActivityFeed";

const published: SkillActivityEvent = {
  kind: "registry.published",
  ts: "2026-11-01T00:00:00Z",
  payload: { slug: "code-review", version: "1.0.0", actor: "a@x" },
} as unknown as SkillActivityEvent;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ActivityFeed", () => {
  it("shows the failure instead of an empty feed", async () => {
    api.skillsActivity.mockRejectedValueOnce(new Error("offline"));
    render(<ActivityFeed />);
    await act(async () => {});
    expect(screen.getByText("Could not load activity.")).toBeTruthy();
    expect(screen.queryByText("No activity yet.")).toBeNull();
  });

  it("keeps the loaded rows when a refetch fails", async () => {
    api.skillsActivity.mockResolvedValueOnce([published]);
    render(<ActivityFeed />);
    await act(async () => {});
    const before = document.body.textContent;
    expect(before).toContain("code-review");
    api.skillsActivity.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByLabelText("Filter activity: Changes to skills"));
    await act(async () => {});
    expect(document.body.textContent).toContain("code-review");
    expect(screen.getByText("Could not load activity.")).toBeTruthy();
  });
});
