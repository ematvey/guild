import type { ChatSummary } from "../../lib/api/chats";
import { sidebarGrouping } from "../projects/projects";
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
      <ChatListItem
        title="Deploy notes"
        active
        status={idle}
        onClick={() => {}}
        onRename={() => {}}
        onArchive={() => {}}
      />,
    );
    expect(html).toContain("Deploy notes");
    expect(html).toContain("bg-sidebar-accent");
    expect(html).toContain("Row actions");
  });

  it("leads a routine's chat with the routine mark", () => {
    const marked = renderToStaticMarkup(
      <ChatListItem title="Jira digest" active={false} status={idle} onClick={() => {}} routine="Jira digest" />,
    );
    expect(marked).toContain("data-routine-mark");
    expect(marked).toContain("Routine: Jira digest");
    const plain = renderToStaticMarkup(
      <ChatListItem title="Deploy notes" active={false} status={idle} onClick={() => {}} />,
    );
    expect(plain).not.toContain("data-routine-mark");
  });

  it("shows a spinner while a descendant is working", () => {
    const html = renderToStaticMarkup(
      <ChatListItem
        title="t"
        active={false}
        status={{ generating: false, working: true, unread: false }}
        onClick={() => {}}
      />,
    );
    expect(html).toContain("animate-spin");
    expect(html).toContain('aria-label="Working"');
    expect(html).not.toContain("unseen replies");
  });

  it("keeps a fixed row height and a title line box when the title is empty", () => {
    const html = renderToStaticMarkup(<ChatListItem title="" active={false} status={idle} onClick={() => {}} />);
    expect(html).toContain("h-8");
    expect(html).toContain("data-title-placeholder");
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
  it("pins a renamed Assistant inbox above a newer ordinary chat named Assistant", () => {
    const ordinary: ChatSummary = {
      id: "regular",
      org_id: "org",
      user_id: "member",
      title: "Assistant",
      created_at: "2026-11-21T10:00:00Z",
      last_activity_at: "2026-11-21T12:00:00Z",
      generating: false,
      working: false,
      unread: false,
      blocked: false,
      machine_online: false,
      type: "user",
      archived: false,
      deleted: false,
    };
    const inbox: ChatSummary = {
      ...ordinary,
      id: "inbox",
      title: "My renamed assistant",
      assistant_inbox: true,
      project_id: "project",
      last_activity_at: "2026-11-21T09:00:00Z",
    };
    const render = (chats: ChatSummary[]) =>
      renderToStaticMarkup(
        <ChatsPanel
          grouping={sidebarGrouping(chats)}
          loadingChats={false}
          chatId={null}
          onNewChat={() => {}}
          onOpenChat={() => {}}
        />,
      );
    const html = render([ordinary, inbox]);
    expect(html).toContain('aria-label="Assistant conversations"');
    expect(html.indexOf(">My renamed assistant<")).toBeLessThan(html.indexOf(">Assistant<"));
    expect(html.split(">My renamed assistant<")).toHaveLength(2);
    expect(render([ordinary])).not.toContain('aria-label="Assistant conversations"');
  });

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
        archivedGrouping={{ visible: [], chatsByProject: {} } as any}
        loadingChats={false}
        loadingArchivedChats={false}
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
    const html = renderToStaticMarkup(<SettingsPanel role="member" activeSection={null} onSelectSection={() => {}} />);
    expect(html).toContain("User");
    expect(html).not.toContain("Workspace");
  });

  it("shows the workspace group to an admin and marks the active section", () => {
    const html = renderToStaticMarkup(
      <SettingsPanel role="admin" activeSection="general" onSelectSection={() => {}} />,
    );
    expect(html).toContain("Workspace");
    expect(html).toContain("bg-sidebar-accent");
  });
});
