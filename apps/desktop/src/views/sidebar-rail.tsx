import {
  ArrowUpRight,
  CalendarClock,
  ArrowLeft,
  ArrowRight,
  Cpu,
  Folder,
  Search,
  SquarePen,
  Settings,
  LayoutGrid,
  MessageSquare,
  Package,
  PanelLeftOpen,
} from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@guild/ui/components/dropdown-menu";
import { Button } from "@guild/ui/components/button";
import { UserBadge } from "../components/user-badge";
import { ServerMenuItems } from "./server-menu";
import { CloseSidebarButton, CollapseButton } from "./sidebar/chrome";
import { TITLE_BAR_INSET, TOP_ROW, titleBarDragDeep } from "../lib/titlebar";
import type { ChatRoute } from "./thread/route";

export type RailTab = ChatRoute["tab"] | "skills" | "apps";

export function WorkSidebarHeader({
  onCollapse,
  onClose,
}: {
  onCollapse?: () => void;
  onClose?: () => void;
}) {
  return (
    <div {...titleBarDragDeep} className={`flex shrink-0 items-center gap-1 px-2 ${TOP_ROW}`}>
      <CollapseButton onCollapse={onCollapse} />
      {onCollapse && (
        <div className="flex shrink-0 items-center">
          <Button variant="ghost" size="icon" className="size-7" aria-label="Go back" title="Go back" onClick={() => window.history.back()}>
            <ArrowLeft />
          </Button>
          <Button variant="ghost" size="icon" className="size-7" aria-label="Go forward" title="Go forward" onClick={() => window.history.forward()}>
            <ArrowRight />
          </Button>
        </div>
      )}
      {onClose && <CloseSidebarButton onClose={onClose} />}
    </div>
  );
}

const workPages = [
  { id: "chats", label: "Chats", icon: MessageSquare },
  { id: "skills", label: "Skills", icon: Package },
  { id: "apps", label: "Apps", icon: LayoutGrid },
  { id: "routines", label: "Scheduled", icon: CalendarClock },
] as const;

export function WorkNavigation({
  active,
  onNewChat,
  onSearch,
  onProjects,
  onTabChange,
  onOpenRoutines,
}: {
  active: RailTab | "routines" | "projects";
  onNewChat: () => void;
  onSearch: () => void;
  onProjects: () => void;
  onTabChange: (tab: RailTab) => void;
  onOpenRoutines?: () => void;
}) {
  const items = [
    { label: "New", icon: SquarePen, open: onNewChat },
    { label: "Search", icon: Search, open: onSearch },
    { id: "projects", label: "Projects", icon: Folder, open: onProjects },
    { id: "apps", label: "Apps", icon: LayoutGrid, open: () => onTabChange("apps") },
    { id: "routines", label: "Scheduled", icon: CalendarClock, open: onOpenRoutines },
    { id: "skills", label: "Skills", icon: Package, open: () => onTabChange("skills") },
  ];
  return (
    <nav aria-label="Work navigation" className="shrink-0 space-y-0.5 px-2 pb-2 pt-1">
      {items.map(({ id, label, icon: Icon, open }) => (
        <Button
          key={label}
          variant="ghost"
          size="sm"
          className="guild-sidebar-current h-8 w-full justify-start px-2 text-base font-normal pointer-coarse:h-10"
          aria-current={id === active ? "page" : undefined}
          aria-haspopup={label === "Search" ? "dialog" : undefined}
          onClick={open}
          disabled={!open}
        >
          <Icon aria-hidden="true" />
          {label}
        </Button>
      ))}
    </nav>
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
  workspaceName,
  collapsed = false,
  onExpand,
}: {
  onTabChange: (tab: RailTab) => void;
  onOpenSettings: (section: string) => void;
  onOpenControl?: () => void;
  onOpenHelp: () => void;
  onOpenRoutines?: () => void;
  email: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  onOpenDevice: () => void;
  onSignOut: () => void;
  onAddWorkspace?: (baseUrl?: string) => void;
  workspaceName?: string;
  collapsed?: boolean;
  onExpand?: () => void;
}) {
  return (
    <div
      className={
        collapsed
          ? `guild-sidebar-theme flex shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar px-1 py-2 ${TITLE_BAR_INSET}`
          : "shrink-0 border-t border-border/60 px-2 py-2"
      }
    >
      {collapsed && (
        <Button variant="ghost" size="icon" onClick={onExpand} aria-label="Expand sidebar">
          <PanelLeftOpen />
        </Button>
      )}
      <UserBadge email={email} displayName={displayName} avatarUrl={avatarUrl} compact={collapsed}>
        {onAddWorkspace ? (
          <>
            <ServerMenuItems onAddWorkspace={onAddWorkspace} onReload={() => window.location.reload()} />
            <DropdownMenuSeparator />
          </>
        ) : workspaceName && (
          <>
            <div className="min-w-0 px-2 py-1.5">
              <div className="text-base text-muted-foreground">Workspace</div>
              <div className="truncate text-base font-medium" title={workspaceName}>{workspaceName}</div>
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        {collapsed && (
          <>
            {workPages
              .filter(({ id }) => id !== "routines" || onOpenRoutines)
              .map(({ id, label }) => (
                <DropdownMenuItem className="text-base" key={id} onSelect={() => (id === "routines" ? onOpenRoutines?.() : onTabChange(id))}>
                  {label}
                </DropdownMenuItem>
              ))}
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem className="text-base" onSelect={() => onOpenSettings("account")}><Settings />Settings</DropdownMenuItem>
        <DropdownMenuItem className="text-base" onSelect={() => onOpenSettings("machine")}><Cpu />Devices</DropdownMenuItem>
        {collapsed && <DropdownMenuItem className="text-base" onClick={onOpenDevice}>Set up a device</DropdownMenuItem>}
        {onOpenControl && <DropdownMenuItem className="text-base" onSelect={onOpenControl}><ArrowUpRight />Control Center</DropdownMenuItem>}
        <DropdownMenuItem className="text-base" onClick={onOpenHelp}>Help</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem className="text-base text-destructive focus:text-destructive" onClick={onSignOut}>
          Sign out
        </DropdownMenuItem>
      </UserBadge>
    </div>
  );
}
