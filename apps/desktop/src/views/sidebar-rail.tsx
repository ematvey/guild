import {
  ArrowUpRight,
  CalendarClock,
  Check,
  ChevronDown,
  Cpu,
  Settings,
  LayoutGrid,
  MessageSquare,
  Package,
  PanelLeftOpen,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
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

export function WorkPageSwitcher({
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
  const pages = workPages.filter(({ id }) => id !== "routines" || onOpenRoutines);
  const current = pages.find(({ id }) => id === active);
  const Icon = current?.icon ?? (active === "device" ? Cpu : Settings);
  const label = current?.label ?? (active === "device" ? "Devices" : "Settings");
  return (
    <nav aria-label="Work navigation" className="flex shrink-0 items-center gap-1 px-2 pb-2 pt-1">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="min-w-0 flex-1 justify-start bg-background/50"
            aria-label={`Switch Work page, current: ${label}`}
          >
            <Icon />
            <span className="flex-1 truncate text-left">{label}</span>
            <ChevronDown className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-40">
          {pages.map(({ id, icon: ItemIcon, label: itemLabel }) => (
            <DropdownMenuItem
              key={id}
              onSelect={() => (id === "routines" ? onOpenRoutines?.() : onTabChange(id))}
              aria-current={id === active ? "page" : undefined}
            >
              <ItemIcon className="size-4" />
              {itemLabel}
              {id === active && <Check className="ml-auto size-4" aria-hidden="true" />}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button
        variant="ghost"
        size="icon"
        className="guild-sidebar-current size-8 shrink-0"
        aria-label="Devices"
        title="Devices"
        aria-current={active === "device" ? "page" : undefined}
        onClick={() => onOpenSettings("machine")}
      >
        <Cpu />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="guild-sidebar-current size-8 shrink-0"
        aria-label="Settings"
        title="Settings"
        aria-current={active === "settings" ? "page" : undefined}
        onClick={() => onOpenSettings("appearance")}
      >
        <Settings />
      </Button>
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
          : "shrink-0 border-t border-border px-2 pb-2 pt-1.5"
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
