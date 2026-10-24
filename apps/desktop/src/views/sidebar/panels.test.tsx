// Sidebar markup contracts: the chat row's status affordances, the project
// row's machine label and fold-out toggle, and the panel headers' controls.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ChatListItem, ProjectHeader } from "./rows";
import { ChatsPanel } from "./chats-panel";
import { SettingsPanel } from "./settings-panel";
import { WorkPanel } from "./work-panel";

const idle = { generating: false, unread: false };

describe("ChatListItem", () => {
  it("marks the open chat and offers rename and archive", () => {
    const html = renderToStaticMarkup(
      <ChatListItem title="Deploy notes" active status={idle} onClick={() => {}} onRename={() => {}} onArchive={() => {}} />,
    );
    expect(html).toContain("Deploy notes");
    expect(html).toContain("bg-accent");
    expect(html).toContain("Row actions");
  });

  it("shows a spinner while generating and a dot when unread", () => {
    const generating = renderToStaticMarkup(
      <ChatListItem title="t" active={false} status={{ generating: true, unread: true }} onClick={() => {}} />,
    );
    expect(generating).toContain("animate-spin");
    expect(generating).not.toContain("unseen replies");
    const unread = renderToStaticMarkup(
      <ChatListItem title="t" active={false} status={{ generating: false, unread: true }} onClick={() => {}} />,
    );
    expect(unread).toContain("unseen replies");
  });

  it("hides the row menu when no action is available", () => {
    const html = renderToStaticMarkup(<ChatListItem title="t" active={false} status={idle} onClick={() => {}} />);
    expect(html).not.toContain("Row actions");
  });
});

describe("ProjectHeader", () => {
  const base = {
    name: "guild",
    folder: "/home/u/guild",
    status: idle,
    open: false,
    onToggle: () => {},
    onRename: () => {},
    onArchive: () => {},
  };

  it("carries the machine name and its online dot", () => {
    const html = renderToStaticMarkup(<ProjectHeader {...base} machine={{ name: "dev-1", online: true }} />);
    expect(html).toContain("dev-1");
    expect(html).toContain("bg-emerald-500");
    expect(html).toContain('title="/home/u/guild"');
  });

  it("hides the dot while the machine state is unknown", () => {
    const html = renderToStaticMarkup(<ProjectHeader {...base} machine={{ name: "dev-1", online: undefined }} />);
    expect(html).toContain("dev-1");
    expect(html).not.toContain("bg-emerald-500");
    expect(html).not.toContain("bg-muted-foreground/40");
  });

  it("rotates the chevron when open and offers the project's new chat", () => {
    const html = renderToStaticMarkup(<ProjectHeader {...base} open onNewChat={() => {}} />);
    expect(html).toContain("rotate-90");
    expect(html).toContain("New chat in this project");
  });
});

describe("panels", () => {
  it("names each tab and offers the new-chat control", () => {
    const chats = renderToStaticMarkup(
      <ChatsPanel
        grouping={{ visible: [], chatsByProject: {} } as any}
        loadingChats={false}
        chatId={null}
        onNewChat={() => {}}
        onOpenChat={() => {}}
      />,
    );
    expect(chats).toContain(">Chats<");
    expect(chats).toContain("New thread");
    expect(chats).toContain("No conversations yet.");

    const work = renderToStaticMarkup(
      <WorkPanel
        grouping={{ visible: [], chatsByProject: {} } as any}
        loadingChats={false}
        projects={[]}
        chatId={null}
        onOpenChat={() => {}}
        onNewProject={() => {}}
      />,
    );
    expect(work).toContain(">Projects<");
    expect(work).toContain("New project");
    expect(work).toContain("No projects yet.");
  });

  it("hides admin-only settings sections from a member", () => {
    const html = renderToStaticMarkup(
      <SettingsPanel role="member" activeSection={null} onSelectSection={() => {}} />,
    );
    expect(html).toContain("User");
    expect(html).not.toContain("Workspace");
  });

  it("shows the workspace group to an admin and marks the active section", () => {
    const html = renderToStaticMarkup(
      <SettingsPanel role="admin" activeSection="general" onSelectSection={() => {}} />,
    );
    expect(html).toContain("Workspace");
    expect(html).toContain("bg-accent");
  });
});
