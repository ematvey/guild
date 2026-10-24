import { useEffect, useRef, useState } from "react";
import { PanelLeftClose, X } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { DesktopTooltip } from "../../components/desktop-tooltip";

/** Row title that fades out at the right edge when it overflows (instead
 * of an ellipsis); also used by the composer's project chip in WebChat. */
export function FadeTitle({ text }: { text: string }) {
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
        maskImage: "linear-gradient(to right, black calc(100% - 22px), transparent)",
        WebkitMaskImage: "linear-gradient(to right, black calc(100% - 22px), transparent)",
      }
    : undefined;

  return (
    <span ref={ref} className="block min-w-0 flex-1 whitespace-nowrap" style={fade}>
      {text}
    </span>
  );
}

/** Inline rename field: Enter or blur commits, Esc cancels; `onDone(null)`


/** Collapse button shared by every panel header (desktop only). The
 *  tooltip carries the toggle hotkey like the rail's tooltips do. */
export function CollapseButton({ onCollapse }: { onCollapse?: () => void }) {
  return onCollapse ? (
    <DesktopTooltip label="Toggle sidebar" hotkey="mod+B">
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground"
        onClick={onCollapse}
        aria-label="Toggle sidebar"
      >
        <PanelLeftClose />
      </Button>
    </DesktopTooltip>
  ) : null;
}

/** Drawer close for the mobile sidebar sheet: the built-in SheetContent
 *  corner close is suppressed there (it would sit on top of the header's

/** Drawer close for the mobile sidebar sheet: the built-in SheetContent
 *  corner close is suppressed there (it would sit on top of the header's
 *  new-thread button), so the header carries its own labeled X. */
export function CloseSidebarButton({ onClose }: { onClose: () => void }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-7 text-muted-foreground"
      onClick={onClose}
      aria-label="Close sidebar"
    >
      <X />
    </Button>
  );
}
