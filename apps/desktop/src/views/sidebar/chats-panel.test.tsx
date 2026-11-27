// @vitest-environment happy-dom
// The Projects panel's archived fold-out: an archived project opens onto the
// chats archived with it, which the live chat list does not carry.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ChatsPanel } from "./chats-panel";
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

describe("ChatsPanel archived section", () => {
  it("folds an archived project out to its archived chats", () => {
    const archived = project("p-arch", "old-notes");
    render(
      <ChatsPanel
        grouping={sidebarGrouping([chat("c-live", "Live chat", null)])}
        archivedChats={[chat("c-arch", "Archived chat", archived.id)]}
        loadingChats={false}
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
      <ChatsPanel
        grouping={sidebarGrouping([])}
        archivedChats={[]}
        loadingChats={false}
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

it("shows synced pins, keeps project threads in Recent, and hides archived project threads there", () => {
  const liveProject = { ...project("active", "Active folder"), pinned_at: "2026-01-01T00:00:00Z" };
  const oldProject = project("old", "Archived folder");
  const liveChat = {
    ...chat("live", "Active conversation", liveProject.id),
    archived: false,
    pinned_at: "2026-01-02T00:00:00Z",
  };
  const hidden = {
    ...chat("hidden", "Hidden conversation", oldProject.id),
    archived: false,
    pinned_at: liveChat.pinned_at,
  };
  const onPinChat = vi.fn();
  render(
    <ChatsPanel
      grouping={sidebarGrouping([liveChat, hidden])}
      projects={[liveProject]}
      archivedProjects={[oldProject]}
      loadingChats={false}
      chatId={liveChat.id}
      projectId={liveProject.id}
      onOpenChat={() => {}}
      onPinChat={onPinChat}
    />,
  );
  const pinned = within(screen.getByRole("region", { name: "Pinned" }));
  const recent = within(screen.getByRole("region", { name: "Chats and tasks" }));
  expect(pinned.getAllByText("Active conversation")).toHaveLength(1);
  expect(recent.getByText("Active conversation")).toBeDefined();
  expect(screen.queryByText("Hidden conversation")).toBeNull();
  expect(screen.getAllByText("Active folder")).toHaveLength(1);
  fireEvent.click(recent.getByRole("button", { name: "Unpin" }));
  expect(onPinChat).toHaveBeenCalledWith(liveChat.id, false);
});


it("keeps sidebar sections and project folders as the member left them when switching threads", () => {
  const folder = project("p-live", "Project folder");
  const pinned = { ...project("p-pin", "Pinned folder"), pinned_at: "2026-01-02T00:00:00Z" };
  const chats = sidebarGrouping([]);
  const panel = (chatId: string | null, projectId: string | null) => (
    <ChatsPanel
      grouping={chats}
      projects={[folder, pinned]}
      loadingChats={false}
      chatId={chatId}
      projectId={projectId}
      onOpenChat={() => {}}
    />
  );
  const { rerender } = render(panel("c-plain", null));
  const pins = screen.getByRole("button", { name: /^Pinned$/ });
  fireEvent.click(pins);
  rerender(panel("c-project", folder.id));
  expect(screen.queryByText("Project folder")).toBeNull();
  rerender(panel("c-pinned-project", pinned.id));
  expect(pins.getAttribute("aria-expanded")).toBe("false");

  rerender(panel(null, pinned.id));
  expect(pins.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByText("Pinned folder").closest("button")!.getAttribute("aria-expanded")).toBe("true");
});

it("opens a project destination from its list row", () => {
  const folder = project("p-work", "Work folder");
  const onOpenProject = vi.fn();
  const props = {
    grouping: sidebarGrouping([]),
    mode: "projects" as const,
    projects: [folder],
    loadingChats: false,
    chatId: null,
    onOpenChat: vi.fn(),
    onOpenProject,
  };
  const { rerender } = render(<ChatsPanel {...props} />);
  const row = screen.getByRole("button", { name: /Work folder/ });
  expect(row.textContent).toBe("dev-1Work folder");
  expect(row.querySelector(".lucide-folder")).toBeNull();
  fireEvent.click(row);
  expect(onOpenProject).toHaveBeenCalledWith(folder.id);

  rerender(<ChatsPanel {...props} projectId={folder.id} />);
  expect(screen.getByRole("heading", { name: folder.name })).toBeDefined();
  expect(screen.getByText("No chats yet.")).toBeDefined();
});
