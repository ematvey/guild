import {
  ArrowUpRight,
  CalendarClock,
  ArrowLeft,
  ArrowRight,
  MonitorSmartphone,
  Folder,
  Search,
  SquarePen,
  Settings,
  LayoutGrid,
  Package,
} from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@guild/ui/components/dropdown-menu";
import { Button } from "@guild/ui/components/button";
import { UserBadge } from "../components/user-badge";
import { ServerMenuItems } from "./server-menu";
import { CloseSidebarButton, CollapseButton } from "./sidebar/chrome";
import { TOP_ROW, titleBarDragDeep } from "../lib/titlebar";
import type { ChatRoute } from "./thread/route";

export type RailTab = ChatRoute["tab"] | "skills" | "apps";

export function WorkSidebarHeader({
  onToggle,
  expanded,
  onClose,
  showDivider,
}: {
  onToggle?: () => void;
  expanded?: boolean;
  onClose?: () => void;
  showDivider?: boolean;
}) {
  return (
    <div {...titleBarDragDeep} className={`flex shrink-0 items-center gap-1 pl-3 pr-2 ${TOP_ROW} ${showDivider ? "border-b border-border/60" : "border-b border-transparent"}`}>
      <CollapseButton onCollapse={onToggle} expanded={expanded} />
      {onToggle && (
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
    { id: "routines", label: "Scheduled tasks", icon: CalendarClock, open: onOpenRoutines },
    { id: "skills", label: "Customize", icon: Package, open: () => onTabChange("skills") },
  ];
  return (
    <nav aria-label="Guild navigation" className="shrink-0 space-y-0.5 pl-3 pb-2 pt-1">
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
  onOpenSettings,
  onSetupDevice,
  onOpenControl,
  onOpenHelp,
  email,
  displayName,
  avatarUrl,
  onSignOut,
  onAddWorkspace,
  workspaceName,
}: {
  onOpenSettings: (section: string) => void;
  onSetupDevice: () => void;
  onOpenControl?: () => void;
  onOpenHelp: () => void;
  email: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  onSignOut: () => void;
  onAddWorkspace?: (baseUrl?: string) => void;
  workspaceName?: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1 border-t border-border/60 pl-3 pr-1 py-2">
      <div className="min-w-0 flex-1">
        <UserBadge email={email} displayName={displayName} avatarUrl={avatarUrl}>
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
          <DropdownMenuItem className="text-base" onSelect={() => onOpenSettings("account")}><Settings />Settings</DropdownMenuItem>
          <DropdownMenuItem className="text-base" onSelect={() => onOpenSettings("machine")}><MonitorSmartphone />Devices</DropdownMenuItem>
          {onOpenControl && <DropdownMenuItem className="text-base" onSelect={onOpenControl}><ArrowUpRight />Guild Control Center</DropdownMenuItem>}
          <DropdownMenuItem className="text-base" onClick={onOpenHelp}>Help</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-base text-destructive focus:text-destructive" onClick={onSignOut}>
            Sign out
          </DropdownMenuItem>
        </UserBadge>
      </div>
      <Button variant="ghost" size="icon"
        aria-label="Set up a device" title="Set up a device" aria-haspopup="dialog"
        className="shrink-0 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onSetupDevice}
      >
        <MonitorSmartphone />
      </Button>
    </div>
  );
}
