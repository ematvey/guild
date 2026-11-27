import {
  ArrowUpRight,
  CalendarClock,
  Cpu,
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

const workPages = [
  { id: "chats", label: "Chats", icon: MessageSquare },
  { id: "skills", label: "Skills", icon: Package },
  { id: "apps", label: "Apps", icon: LayoutGrid },
  { id: "routines", label: "Routines", icon: CalendarClock },
] as const;

export function WorkPageShortcuts({
  active,
  onTabChange,
  onOpenRoutines,
  onOpenSettings,
}: {
  active: RailTab | "routines" | "device";
  onTabChange: (tab: RailTab) => void;
  onOpenRoutines?: () => void;
  onOpenSettings: (section: string) => void;
}) {
  const shortcuts = [
    ...workPages
      .filter(({ id }) => id !== "routines" || onOpenRoutines)
      .map(({ id, label, icon }) => ({
        id,
        label,
        icon,
        open: () => (id === "routines" ? onOpenRoutines?.() : onTabChange(id)),
      })),
    { id: "device", label: "Devices", icon: Cpu, open: () => onOpenSettings("machine") },
    { id: "settings", label: "Settings", icon: Settings, open: () => onOpenSettings("appearance") },
  ];
  return (
    <nav aria-label="Work navigation" className="flex shrink-0 gap-0.5 border-t border-border px-2 py-1.5">
      {shortcuts.map(({ id, label, icon: Icon, open }) => (
        <Button
          key={id}
          variant="ghost"
          size="icon"
          className="guild-sidebar-current h-9 min-w-0 flex-1 text-muted-foreground pointer-coarse:h-11"
          aria-label={label}
          title={label}
          aria-current={active === id ? "page" : undefined}
          onClick={open}
        >
          <Icon />
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
  collapsed = false,
  onExpand,
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
}) {
  return (
    <div
      className={
        collapsed
          ? `guild-sidebar-theme flex shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar px-1 py-2 ${TITLE_BAR_INSET}`
          : "shrink-0 px-2 pb-2"
      }
    >
      {collapsed && (
        <Button variant="ghost" size="icon" onClick={onExpand} aria-label="Expand sidebar">
          <PanelLeftOpen />
        </Button>
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
            {workPages
              .filter(({ id }) => id !== "routines" || onOpenRoutines)
              .map(({ id, label }) => (
                <DropdownMenuItem key={id} onSelect={() => (id === "routines" ? onOpenRoutines?.() : onTabChange(id))}>
                  {label}
                </DropdownMenuItem>
              ))}
            <DropdownMenuItem onSelect={() => onOpenSettings("machine")}>Devices</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => onOpenSettings("appearance")}>Settings</DropdownMenuItem>
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
