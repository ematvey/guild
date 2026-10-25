//! Sidebar account badge: the shared Avatar (photo when set, initials
//! otherwise), display name, and a dropdown whose items the caller supplies.

import { ChevronUp } from "lucide-react";
import { Avatar } from "@guild/ui/components/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@guild/ui/components/dropdown-menu";
import { DesktopTooltip } from "./desktop-tooltip";

export function UserBadge({
  email,
  displayName,
  avatarUrl,
  compact,
  children,
}: {
  email: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  /** Icon-only trigger (avatar/initials, no name row) for narrow rails. */
  compact?: boolean;
  /** Dropdown menu contents (DropdownMenuItem and friends). */
  children?: React.ReactNode;
}) {
  const initials = (displayName ?? email).slice(0, 2).toUpperCase();
  const trigger = (
    <button
      className={
        compact
          ? "flex size-9 items-center justify-center rounded-md outline-none transition-colors hover:bg-accent"
          : "flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-accent"
      }
      title="Account"
    >
      <Avatar
        src={avatarUrl}
        fallback={initials}
        className="size-7"
        fallbackClassName="bg-primary text-xs font-semibold text-primary-foreground"
      />
      {!compact && (
        <>
          <span
            className="min-w-0 flex-1 truncate text-muted-foreground"
            title={email}
          >
            {displayName ?? email}
          </span>
          <ChevronUp className="size-3 shrink-0 text-muted-foreground" />
        </>
      )}
    </button>
  );
  return (
    <DropdownMenu>
      {compact ? (
        <DesktopTooltip label={displayName ?? email} side="right">
          <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
        </DesktopTooltip>
      ) : (
        <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      )}
      <DropdownMenuContent side="top" align="start" className="w-56">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
