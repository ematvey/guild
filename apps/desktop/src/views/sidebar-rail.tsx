// Icon rail left of the sidebar panel (desktop): switches the panel between
// chats, projects (work) and settings. The account menu lives here too —
// it is global across tabs and never scrolls away.

import { FolderKanban, MessageSquare, Settings } from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@guild/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@guild/ui/components/tooltip";
import { UserBadge } from "../components/user-badge";
import { WorkspaceRailButton } from "./workspace-menu";
import { IS_TAURI } from "../transport";

export type SidebarTab = "chats" | "work" | "settings";

export const SIDEBAR_TAB_KEY = "guild.sidebarTab";

const TABS: { id: SidebarTab; label: string; icon: typeof MessageSquare }[] = [
  { id: "chats", label: "Chats", icon: MessageSquare },
  { id: "work", label: "Work", icon: FolderKanban },
  { id: "settings", label: "Settings", icon: Settings },
];

/** The persisted tab, or "chats" for a missing/invalid value. */
export function storedSidebarTab(): SidebarTab {
  try {
    const raw = localStorage.getItem(SIDEBAR_TAB_KEY);
    return raw === "chats" || raw === "work" || raw === "settings" ? raw : "chats";
  } catch {
    return "chats";
  }
}

/** Persists the tab; private-mode browsers may refuse writes, which is fine
 * (the tab just resets next session). */
export function saveSidebarTab(tab: SidebarTab): void {
  try {
    localStorage.setItem(SIDEBAR_TAB_KEY, tab);
  } catch {
    // storage unavailable — keep the in-memory tab only
  }
}

export function SidebarRail({
  activeTab,
  onTabChange,
  email,
  displayName,
  avatarUrl,
  onOpenSettings,
  onOpenDevice,
  onSignOut,
  onAddWorkspace,
}: {
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  email: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  /** No-arg form opens the settings overlay root (the account menu entry). */
  onOpenSettings: (section?: string) => void;
  onOpenDevice: () => void;
  onSignOut: () => void;
  /** Desktop multi-workspace: the rail's first button hosts the switcher. */
  onAddWorkspace?: () => void;
}) {
  return (
    <nav className="flex h-full w-12 shrink-0 flex-col items-center border-r border-border bg-sidebar py-2 text-sidebar-foreground">
      <div className="flex flex-col items-center gap-1">
        {/* First button: the active workspace (logo/initial); its dropdown
            carries the switcher rows. Renders nothing on the web. */}
        <WorkspaceRailButton
          onAddWorkspace={onAddWorkspace}
          onReload={() => window.location.reload()}
        />
        {TABS.map(({ id, label, icon: Icon }) => (
          <Tooltip key={id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={label}
                aria-current={activeTab === id}
                onClick={() => onTabChange(id)}
                className={`flex size-9 items-center justify-center rounded-md outline-none transition-colors ${
                  activeTab === id
                    ? "bg-accent text-accent-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <Icon className="size-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">{label}</TooltipContent>
          </Tooltip>
        ))}
      </div>
      <div className="mt-auto p-1">
        <UserBadge email={email} displayName={displayName} avatarUrl={avatarUrl} compact>
          <DropdownMenuItem onClick={onOpenDevice}>Set up a device</DropdownMenuItem>
          <DropdownMenuItem onClick={() => onOpenSettings()}>Settings</DropdownMenuItem>
          {/* Browser only: the desktop sign-out lives on the workspace rows
              (inline ×). */}
          {!IS_TAURI && <DropdownMenuSeparator />}
          {!IS_TAURI && (
            <DropdownMenuItem onClick={onSignOut} className="text-destructive focus:text-destructive">
              Sign out
            </DropdownMenuItem>
          )}
        </UserBadge>
      </div>
    </nav>
  );
}
