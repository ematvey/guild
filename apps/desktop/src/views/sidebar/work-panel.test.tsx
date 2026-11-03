// @vitest-environment happy-dom
// The Projects panel's archived fold-out: an archived project opens onto the
// chats archived with it, which the live chat list does not carry.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkPanel } from "./work-panel";
import { sidebarGrouping } from "../projects/projects";
import type { ChatSummary } from "../../lib/api/chats";
import type { Project } from "../../lib/api/projects";

const project = (id: string, name: string): Project => ({
  id,
  name,
  folder: `C:\\work\\${name}`,
  machine_id: "m1",
  machine_label: "dev-1",
  created_at: "2026-01-01T00:00:00Z",
});

const chat = (id: string, title: string, projectId: string | null): ChatSummary =>
  ({
    id,
    title,
    project_id: projectId,
    created_at: "2026-01-01T00:00:00Z",
    archived: true,
  }) as ChatSummary;

afterEach(cleanup);

describe("WorkPanel archived section", () => {
  it("folds an archived project out to its archived chats", () => {
    const archived = project("p-arch", "old-notes");
    render(
      <WorkPanel
        grouping={sidebarGrouping([chat("c-live", "Live chat", null)])}
        archivedGrouping={sidebarGrouping([chat("c-arch", "Archived chat", archived.id)])}
        loadingChats={false}
        loadingArchivedChats={false}
        projects={[]}
        archivedProjects={[archived]}
        chatId={null}
        onOpenChat={() => {}}
        onNewProject={() => {}}
        onUnarchiveProject={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Archived"));
    fireEvent.click(screen.getByText("old-notes"));
    expect(screen.getByText("Archived chat")).toBeDefined();
    expect(screen.queryByText("No chats yet.")).toBeNull();
  });

  it("says a project is empty only when its archived chats are gone", () => {
    const archived = project("p-arch", "old-notes");
    render(
      <WorkPanel
        grouping={sidebarGrouping([])}
        archivedGrouping={sidebarGrouping([])}
        loadingChats={false}
        loadingArchivedChats={false}
        projects={[]}
        archivedProjects={[archived]}
        chatId={null}
        onOpenChat={() => {}}
        onNewProject={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("Archived"));
    fireEvent.click(screen.getByText("old-notes"));
    expect(screen.getByText("No chats yet.")).toBeDefined();
  });
});
