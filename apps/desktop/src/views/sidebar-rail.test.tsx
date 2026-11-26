import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarMenu } from "./sidebar-rail";

function menu(extra: Partial<Parameters<typeof SidebarMenu>[0]> = {}) {
  return renderToStaticMarkup(
    <SidebarMenu
      onTabChange={() => {}}
      onOpenSettings={() => {}}
      onOpenControl={() => {}}
      onOpenHelp={() => {}}
      email="member@example.com"
      onOpenDevice={() => {}}
      onSignOut={() => {}}
      inControl={false}
      {...extra}
    />,
  );
}

describe("SidebarMenu", () => {
  it("uses a single account trigger in the open sidebar", () => {
    const html = menu();
    expect(html).toContain('title="Account"');
    expect(html).not.toContain('aria-label="Expand sidebar"');
  });

  it("offers an expand button when the sidebar is collapsed", () => {
    const html = menu({ collapsed: true, onExpand: () => {} });
    expect(html).toContain('aria-label="Expand sidebar"');
  });
});
