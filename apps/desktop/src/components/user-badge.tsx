//! Sidebar account badge: avatar photo when set, initials fallback
//! otherwise, display name, and a dropdown whose items the caller supplies.

import { useState } from "react";
import { ChevronUp } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@guild/ui/components/dropdown-menu";

export function UserBadge({
  email,
  displayName,
  avatarUrl,
  children,
}: {
  email: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  /** Dropdown menu contents (DropdownMenuItem and friends). */
  children?: React.ReactNode;
}) {
  const initials = (displayName ?? email).slice(0, 2).toUpperCase();
  // The CSP allows no remote img hosts (IdP avatar URLs are blocked), so a
  // failed load falls back to initials instead of a broken image.
  const [avatarBroken, setAvatarBroken] = useState(false);
  const showAvatar = avatarUrl && !avatarBroken;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left outline-none transition-colors hover:bg-accent"
          title="Account"
        >
          {showAvatar ? (
            <img
              src={avatarUrl}
              alt=""
              className="size-7 shrink-0 rounded-full object-cover"
              referrerPolicy="no-referrer"
              onError={() => setAvatarBroken(true)}
            />
          ) : (
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
              {initials}
            </span>
          )}
          <span
            className="min-w-0 flex-1 truncate text-muted-foreground"
            title={email}
          >
            {displayName ?? email}
          </span>
          <ChevronUp className="size-3 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
