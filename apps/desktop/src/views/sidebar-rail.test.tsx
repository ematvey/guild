// The rail's first slot: the Guild mark while the sidebar is open, the
// expand button while it is collapsed, and the account menu's workspace rows.

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarRail } from "./sidebar-rail";

function rail(extra: Partial<Parameters<typeof SidebarRail>[0]> = {}) {
  return renderToStaticMarkup(
    <SidebarRail
      activeTab="chats"
      onTabChange={() => {}}
      onOpenHelp={() => {}}
      email="member@example.com"
      onOpenDevice={() => {}}
      onSignOut={() => {}}
      role="admin"
      {...extra}
    />,
  );
}

describe("SidebarRail", () => {
  it("shows the Guild mark while the sidebar is open", () => {
    const html = rail({ onToggleCollapse: () => {} });
    expect(html).toContain('aria-label="Collapse sidebar"');
    expect(html).not.toContain('aria-label="Expand sidebar"');
    expect(html).toContain("/brand/guild-icon-dark.svg");
  });

  it("shows the expand button while the sidebar is collapsed", () => {
    const html = rail({ collapsed: true, onToggleCollapse: () => {} });
    expect(html).toContain('aria-label="Expand sidebar"');
    expect(html).not.toContain('aria-label="Collapse sidebar"');
  });

  it("keeps the mark inert in the mobile drawer, where nothing collapses", () => {
    const html = rail({ isMobile: true });
    expect(html).not.toContain('aria-label="Collapse sidebar"');
    expect(html).not.toContain('aria-label="Expand sidebar"');
    expect(html).toContain("/brand/guild-icon-dark.svg");
  });
});
