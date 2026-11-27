import { useEffect, useRef, useState } from "react";
import { PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { DesktopTooltip } from "../../components/desktop-tooltip";

/** Row title that fades out at the right edge when it overflows (instead
 * of an ellipsis); also used by the composer's project chip in WebChat. */
export function FadeTitle({ text, fadeWidth = 22 }: { text: string; fadeWidth?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setOverflowing(el.scrollWidth > el.clientWidth);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  const fade = overflowing
    ? {
        maskImage: `linear-gradient(to right, black calc(100% - ${fadeWidth}px), transparent)`,
        WebkitMaskImage: `linear-gradient(to right, black calc(100% - ${fadeWidth}px), transparent)`,
      }
    : undefined;

  return (
    <span ref={ref} className="block min-w-0 flex-1 overflow-hidden whitespace-nowrap" style={fade}>
      {text}
    </span>
  );
}

/** Collapse button shared by every sidebar header (desktop only): the chat,
 *  project, settings, apps and integrations lists all offer it. The tooltip
 *  carries the toggle hotkey like the rail's tooltips do. */
export function CollapseButton({ onCollapse, expanded }: { onCollapse?: () => void; expanded?: boolean }) {
  return onCollapse ? (
    <DesktopTooltip label="Toggle sidebar" hotkey="mod+B">
      <Button
        variant="ghost"
        size="icon"
        className="size-9 text-muted-foreground pointer-coarse:size-10"
        onClick={onCollapse}
        aria-label="Toggle sidebar"
        aria-expanded={expanded}
        aria-controls={expanded === undefined ? undefined : "work-sidebar"}
      >
        {expanded === false ? <PanelLeftOpen /> : <PanelLeftClose />}
      </Button>
    </DesktopTooltip>
  ) : null;
}

/** Drawer close for the mobile sidebar sheet: the built-in SheetContent
 *  corner close is suppressed there (it would sit on top of the header's
 *  new-thread button), so the header carries its own labeled X. */
export function CloseSidebarButton({ onClose }: { onClose: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-9 text-muted-foreground pointer-coarse:size-10"
      onClick={onClose}
      aria-label="Close sidebar"
    >
      <X />
    </Button>
  );
}
