import { ArrowUpRight, CalendarClock, Cpu, Settings, LayoutGrid, MessageSquare, Package, PanelLeftOpen } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@guild/ui/components/dropdown-menu";
import { Button } from "@guild/ui/components/button";
import { UserBadge } from "../components/user-badge";
import { ServerMenuItems } from "./server-menu";
import { CloseSidebarButton, CollapseButton } from "./sidebar/chrome";
import { TITLE_BAR_INSET, TOP_ROW, titleBarDragDeep } from "../lib/titlebar";
import type { ChatRoute } from "./thread/route";

export type RailTab = ChatRoute["tab"] | "skills" | "apps";

export function WorkSidebarHeader({
  workspaceName,
  onCollapse,
  onClose,
}: {
  workspaceName?: string;
  onCollapse?: () => void;
  onClose?: () => void;
}) {
  return (
    <div {...titleBarDragDeep} className={`flex shrink-0 items-center gap-2 px-3 ${TOP_ROW}`}>
      <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border bg-card">
        <img src="/brand/guild-icon-light.svg" alt="" className="size-5 dark:hidden" />
        <img src="/brand/guild-icon-dark.svg" alt="" className="hidden size-5 dark:block" />
      </span>
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">Guild Work</span>
        {workspaceName && <span className="block truncate text-xs text-muted-foreground">{workspaceName}</span>}
      </div>
      <CollapseButton onCollapse={onCollapse} />
      {onClose && <CloseSidebarButton onClose={onClose} />}
    </div>
  );
}

export function SidebarMenu({
  onTabChange,
  onOpenSettings,
  onOpenControl,
  onOpenHelp,
  onOpenRoutines,
  email,
  displayName,
  avatarUrl,
  onOpenDevice,
  onSignOut,
  onAddWorkspace,
  collapsed = false,
  onExpand,
  activeTab,
}: {
  onTabChange: (tab: RailTab) => void;
  onOpenSettings: (section: string) => void;
  onOpenControl: () => void;
  onOpenHelp: () => void;
  onOpenRoutines?: () => void;
  email: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  onOpenDevice: () => void;
  onSignOut: () => void;
  onAddWorkspace?: (baseUrl?: string) => void;
  collapsed?: boolean;
  onExpand?: () => void;
  activeTab?: RailTab | "routines" | "device";
}) {
  const tools = [
    { id: "device", label: "Devices", icon: Cpu, pick: () => onOpenSettings("machine") },
    { id: "settings", label: "Settings", icon: Settings, pick: () => onOpenSettings("appearance") },
    ...(activeTab !== "chats"
      ? [{ id: "chats", label: "Chats", icon: MessageSquare, pick: () => onTabChange("chats") }]
      : []),
    { id: "skills", label: "Skills", icon: Package, pick: () => onTabChange("skills") },
    { id: "apps", label: "Apps", icon: LayoutGrid, pick: () => onTabChange("apps") },
    ...(onOpenRoutines ? [{ id: "routines", label: "Routines", icon: CalendarClock, pick: onOpenRoutines }] : []),
  ];
  return (
    <div
      className={
        collapsed
          ? `guild-sidebar-theme flex shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar px-1 py-2 ${TITLE_BAR_INSET}`
          : "shrink-0 border-t border-border px-2 pb-2 pt-1.5"
      }
    >
      {collapsed ? (
        <Button variant="ghost" size="icon" onClick={onExpand} aria-label="Expand sidebar">
          <PanelLeftOpen />
        </Button>
      ) : (
        <nav aria-label="Work tools" className="mb-1 max-h-[34dvh] space-y-0.5 overflow-y-auto px-1">
          {tools.map(({ id, label, icon: Icon, pick }) => (
            <button
              key={id}
              type="button"
              onClick={pick}
              aria-current={activeTab === id ? "page" : undefined}
              className="guild-sidebar-current flex min-h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm text-muted-foreground outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              {label}
            </button>
          ))}
        </nav>
      )}
      {!collapsed && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenControl}
          className="w-full justify-between px-3 text-muted-foreground"
        >
          Control Center <ArrowUpRight />
        </Button>
      )}
      <UserBadge email={email} displayName={displayName} avatarUrl={avatarUrl} compact={collapsed}>
        {onAddWorkspace && (
          <>
            <ServerMenuItems onAddWorkspace={onAddWorkspace} onReload={() => window.location.reload()} />
            <DropdownMenuSeparator />
          </>
        )}
        {collapsed && (
          <>
            <DropdownMenuItem onClick={() => onTabChange("chats")}>Chats</DropdownMenuItem>
            {tools
              .filter(({ id }) => id !== "chats")
              .map(({ id, label, pick }) => (
                <DropdownMenuItem key={id} onClick={pick}>
                  {label}
                </DropdownMenuItem>
              ))}
            <DropdownMenuItem onClick={onOpenControl}>Control Center</DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {collapsed && <DropdownMenuItem onClick={onOpenDevice}>Set up a device</DropdownMenuItem>}
        <DropdownMenuItem onClick={onOpenHelp}>Help</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onSignOut} className="text-destructive focus:text-destructive">
          Sign out
        </DropdownMenuItem>
      </UserBadge>
    </div>
  );
}
