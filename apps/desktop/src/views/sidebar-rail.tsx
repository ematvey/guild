import { PanelLeftOpen } from "lucide-react";
import { DropdownMenuItem, DropdownMenuSeparator } from "@guild/ui/components/dropdown-menu";
import { Button } from "@guild/ui/components/button";
import { UserBadge } from "../components/user-badge";
import { ServerMenuItems } from "./server-menu";
import type { ChatRoute } from "./thread/route";

export type RailTab = ChatRoute["tab"] | "skills" | "apps";

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
    <nav aria-label="Workspace menu" className={collapsed
      ? "flex shrink-0 flex-col items-center gap-1 border-r border-border bg-sidebar px-1 py-2"
      : "flex shrink-0 items-center justify-between gap-2 border-t border-border px-2 py-1.5"}>
      {collapsed && onExpand && (
        <Button variant="ghost" size="icon" onClick={onExpand} aria-label="Expand sidebar">
          <PanelLeftOpen />
        </Button>
      )}
      <UserBadge email={email} displayName={displayName} avatarUrl={avatarUrl} compact={collapsed}>
        {onAddWorkspace && (
          <>
            <ServerMenuItems onAddWorkspace={onAddWorkspace} onReload={() => window.location.reload()} />
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onClick={() => onTabChange("chats")}>Chats</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onTabChange("skills")}>Skills</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onTabChange("apps")}>Apps</DropdownMenuItem>
            {onOpenRoutines && <DropdownMenuItem onClick={onOpenRoutines}>Routines</DropdownMenuItem>}
            <DropdownMenuItem onClick={() => onOpenSettings("machine")}>Machines</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onOpenSettings("appearance")}>Settings</DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenDevice}>Set up a device</DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenHelp}>Help</DropdownMenuItem>
            <DropdownMenuItem onClick={onOpenControl}>Control Center</DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={onSignOut} className="text-destructive focus:text-destructive">
          Sign out
        </DropdownMenuItem>
      </UserBadge>
    </nav>
  );
}
