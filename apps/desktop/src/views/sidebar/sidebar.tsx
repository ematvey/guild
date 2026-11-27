// The one sidebar column. Every page renders its list inside it — the chat
// list, the projects, the settings sections, the apps, the integrations — so
// the width, the drag handle and the collapsed state are the same everywhere.
import { useCallback, useEffect, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { trackDrag } from "../../lib/drag";
import {
  clampSidebarWidth,
  saveSidebarCollapsed,
  saveSidebarWidth,
  SIDEBAR_COLLAPSED_EVENT,
  SIDEBAR_WIDTH_EVENT,
  storedSidebarCollapsed,
  storedSidebarWidth,
} from "../../lib/sidebar";

/** The shared sidebar state: the width (drag-resizable) and the collapse
 *  flag, both persisted and kept in sync with every mounted surface. */
export function useSidebar() {
  const [width, setWidth] = useState<number>(storedSidebarWidth);
  const [collapsed, setCollapsedState] = useState<boolean>(storedSidebarCollapsed);
  const [resizing, setResizing] = useState(false);

  useEffect(() => {
    const resyncWidth = () => setWidth(storedSidebarWidth());
    const resyncCollapsed = () => setCollapsedState(storedSidebarCollapsed());
    window.addEventListener(SIDEBAR_WIDTH_EVENT, resyncWidth);
    window.addEventListener(SIDEBAR_COLLAPSED_EVENT, resyncCollapsed);
    return () => {
      window.removeEventListener(SIDEBAR_WIDTH_EVENT, resyncWidth);
      window.removeEventListener(SIDEBAR_COLLAPSED_EVENT, resyncCollapsed);
    };
  }, []);

  const setCollapsed = useCallback((next: boolean) => {
    saveSidebarCollapsed(next);
    setCollapsedState(next);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsedState((current) => {
      const next = !current;
      saveSidebarCollapsed(next);
      return next;
    });
  }, []);

  const startDrag = useCallback(
    (e: ReactMouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = width;
      setResizing(true);
      trackDrag(
        (x) => setWidth(clampSidebarWidth(startW + x - startX)),
        () => {
          setResizing(false);
          setWidth((w) => {
            saveSidebarWidth(w);
            return w;
          });
        },
      );
    },
    [width],
  );

  return { width, collapsed, resizing, setCollapsed, toggleCollapsed, startDrag };
}

/** Keep the sidebar mounted so collapsing preserves scroll and expanded rows. */
export function Sidebar({ collapsed, width, resizing, startDrag, children }: {
  collapsed: boolean;
  width: number;
  resizing: boolean;
  startDrag: (event: ReactMouseEvent) => void;
  children: ReactNode;
}) {
  return (
    <aside
      id="work-sidebar"
      aria-label="Sidebar"
      aria-hidden={collapsed || undefined}
      inert={collapsed}
      className={`relative flex shrink-0 ${resizing ? "" : "transition-[width] duration-150 motion-reduce:transition-none"}`}
      style={{ width: collapsed ? 0 : width }}
    >
      <div className="flex min-w-0 flex-1 overflow-hidden">
        <div className="flex shrink-0 flex-col border-r border-border bg-sidebar text-sidebar-foreground" style={{ width }}>
          {children}
        </div>
      </div>
      {!collapsed && (
        <div
          className="absolute inset-y-0 -right-1 z-10 w-1 cursor-col-resize after:absolute after:inset-y-0 after:left-0 after:w-px hover:after:bg-ring"
          onMouseDown={startDrag}
          title="Drag to resize"
        />
      )}
    </aside>
  );
}
