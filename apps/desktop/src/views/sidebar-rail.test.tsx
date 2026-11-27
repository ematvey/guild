import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarMenu, WorkSidebarHeader } from "./sidebar-rail";

function menu(extra: Partial<Parameters<typeof SidebarMenu>[0]> = {}) {
  return renderToStaticMarkup(
    <SidebarMenu
      onOpenSettings={() => {}}
      onOpenControl={() => {}}
      onOpenHelp={() => {}}
      email="member@example.com"
      onSignOut={() => {}}
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

  it("keeps the same desktop header controls in both sidebar states", () => {
    const collapsed = renderToStaticMarkup(<WorkSidebarHeader expanded={false} onToggle={() => {}} />);
    const expanded = renderToStaticMarkup(<WorkSidebarHeader expanded onToggle={() => {}} />);
    expect(collapsed).toContain('aria-expanded="false"');
    expect(expanded).toContain('aria-expanded="true"');
    for (const html of [collapsed, expanded]) {
      expect(html).toContain('aria-label="Toggle sidebar"');
      expect(html).toContain('aria-label="Go back"');
      expect(html).toContain('aria-label="Go forward"');
    }
  });
});
