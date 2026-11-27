// Sidebar account button and its caller-supplied menu.

import { ChevronDown } from "lucide-react";
import { Avatar } from "@guild/ui/components/avatar";
import { Button } from "@guild/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@guild/ui/components/dropdown-menu";
import { FadeTitle } from "../views/sidebar/chrome";
import { avatarChip } from "../lib/format";

export function UserBadge({
  email,
  displayName,
  avatarUrl,
  children,
}: {
  email: string;
  displayName?: string | null;
  avatarUrl?: string | null;
  children?: React.ReactNode;
}) {
  const name = displayName ?? email;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" title="Account" aria-label={name}
          className="max-w-full justify-start gap-2 px-2 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground data-[state=open]:bg-sidebar-accent focus-visible:ring-1 focus-visible:ring-ring">
          <Avatar
            src={avatarUrl}
            fallback={avatarChip(name)}
            className="size-6 shrink-0"
            fallbackClassName="bg-primary font-semibold text-primary-foreground"
          />
          <span className="flex min-w-0 text-left"><FadeTitle text={name} /></span>
          <ChevronDown className="text-muted-foreground" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" className="w-56">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
