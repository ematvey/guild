// Tooltip wrapper for hover-only surfaces: desktop keeps the radix tooltip
// (instant-on-hover, like the icon rail's), touch layouts render the
// trigger bare — a touch-opened tooltip has no hover-leave to dismiss it
// and sticks over neighboring controls.

import type { ReactNode } from "react";
import { useIsMobile } from "@guild/ui/hooks/use-mobile";
import { Tooltip, TooltipContent, TooltipTrigger } from "@guild/ui/components/tooltip";
import { HotkeyHint } from "./hotkey-hint";

export function DesktopTooltip({
  label,
  hotkey,
  browserHotkey,
  side = "bottom",
  children,
}: {
  label: string;
  /** A "+"-separated combo for the HotkeyHint chips ("mod+B", "Ctrl+Alt+N"). */
  hotkey?: string;
  /** Replaces `hotkey` outside the desktop client (browser-reserved keys). */
  browserHotkey?: string;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
}) {
  const isMobile = useIsMobile();
  if (isMobile) return <>{children}</>;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>
        {label}
        {hotkey !== undefined && <HotkeyHint combo={hotkey} browserCombo={browserHotkey} />}
      </TooltipContent>
    </Tooltip>
  );
}
