// Icon rail left of the sidebar panel (desktop): switches the panel between
// chats, projects (work) and skills. Help and Settings sit at the bottom,
// above the account menu — all global across tabs and never scroll away.

import {
  Activity,
  Bot,
  CircleHelp,
  FolderKanban,
  Inbox,
  MessageSquare,
  Package,
  Settings,
} from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@guild/ui/components/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@guild/ui/components/tooltip";
import { UserBadge } from "../components/user-badge";
import { WorkspaceRailButton } from "./workspace-menu";
import { IS_TAURI } from "../transport";

export type SidebarTab =
  | "inbox"
  | "chats"
  | "agents"
  | "work"
  | "activity"
  | "skills"
  | "settings";

const TABS: { id: SidebarTab; label: string; icon: typeof MessageSquare }[] = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "chats", label: "Chats", icon: MessageSquare },
  { id: "agents", label: "Agents", icon: Bot },
  { id: "work", label: "Projects", icon: FolderKanban },
  { id: "activity", label: "Activity", icon: Activity },
  { id: "skills", label: "Skills", icon: Package },
];

/** The bottom rail buttons: Help (a popup, not a panel tab) above Settings
 *  (the panel tab), then the account menu. */
export type RailBottomAction = "help" | "settings";

function RailButton({
  label,
  icon: Icon,
  active,
  onClick,
  badge,
}: {
  label: string;
  icon: typeof MessageSquare;
  active: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-current={active}
          onClick={onClick}
          className={`relative flex size-9 items-center justify-center rounded-md outline-none transition-colors ${
            active
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          <Icon className="size-5" />
          {badge !== undefined && badge > 0 && (
            <span
              aria-label={`${badge} unread`}
              className="absolute -right-0.5 -top-0.5 flex min-w-4 items-center justify-center rounded-full bg-amber-400 px-1 text-3xs font-semibold leading-4 text-black"
            >
              {badge > 99 ? "99+" : badge}
            </span>
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

export function SidebarRail({
  activeTab,
  onTabChange,
  onOpenHelp,
  email,
  displayName,
  avatarUrl,
  onOpenDevice,
  onSignOut,
  onAddWorkspace,
  inboxUnread,
  role,
  isMobile,
}: {
  activeTab: SidebarTab;
  onTabChange: (tab: SidebarTab) => void;
  /** Attention items only — the Inbox badge never counts activity. */
  inboxUnread?: number;
  /** The big help/learn popup (a route overlay, not a panel tab). */
  onOpenHelp: () => void;
  email: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  onOpenDevice: () => void;
  onSignOut: () => void;
  /** Desktop multi-workspace: the rail's first button hosts the switcher. */
  onAddWorkspace?: () => void;
  /** Activity is an admin surface; members never see its rail entry. */
  role?: string;
  /** Mobile drawer: the skills page is a desktop-only surface (its main
   *  column does not render on mobile), so its tab is dropped. */
  isMobile?: boolean;
}) {
  const tabs = (role === "admin" ? TABS : TABS.filter((tab) => tab.id !== "activity")).filter(
    (tab) => !(isMobile && tab.id === "skills"),
  );
  return (
    <nav className="flex h-full w-12 shrink-0 flex-col items-center border-r border-border bg-sidebar py-2 text-sidebar-foreground">
      <div className="flex flex-col items-center gap-1">
        {/* First button: the active workspace (logo/initial); its dropdown
            carries the switcher rows. Renders nothing on the web. */}
        <WorkspaceRailButton
          onAddWorkspace={onAddWorkspace}
          onReload={() => window.location.reload()}
        />
        {tabs.map(({ id, label, icon: Icon }) => (
          <RailButton
            key={id}
            label={label}
            icon={Icon}
            active={activeTab === id}
            onClick={() => onTabChange(id)}
            badge={id === "inbox" ? inboxUnread : undefined}
          />
        ))}
      </div>
      <div className="mt-auto flex flex-col items-center gap-1">
        <RailButton
          label="Help / Learn"
          icon={CircleHelp}
          active={false}
          onClick={onOpenHelp}
        />
        <RailButton
          label="Settings"
          icon={Settings}
          active={activeTab === "settings"}
          onClick={() => onTabChange("settings")}
        />
        <div className="p-1">
          <UserBadge email={email} displayName={displayName} avatarUrl={avatarUrl} compact>
            <DropdownMenuItem onClick={onOpenDevice}>Set up a device</DropdownMenuItem>
            <DropdownMenuItem onClick={() => onTabChange("settings")}>Settings</DropdownMenuItem>
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
      </div>
    </nav>
  );
}
