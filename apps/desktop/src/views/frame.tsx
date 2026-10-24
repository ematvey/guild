// The transcript's collapsible block: a clickable text row on the page with
// no chip background, and its content below once opened. Tools, reasoning,
// approvals and subagent records all use it, so a record in the thread looks
// the same whatever it carries.

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

export function Frame({
  icon,
  title,
  badge,
  defaultOpen = false,
  className,
  children,
}: {
  icon?: React.ReactNode;
  /** A node, or a render function receiving `open` (to e.g. hide the
   * collapsed-row preview once the full content is shown below). */
  title: React.ReactNode | ((open: boolean) => React.ReactNode);
  badge?: React.ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const titleNode = typeof title === "function" ? title(open) : title;
  return (
    <div className={`flex w-full flex-col text-sm ${className ?? ""}`}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 py-1 text-left outline-none transition-colors hover:text-foreground"
      >
        {icon}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">{titleNode}</span>
        {badge}
        {open ? (
          <ChevronUp className="size-3 shrink-0 text-muted-foreground/60" />
        ) : (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground/60" />
        )}
      </button>
      {open && (
        // No card boundary: the content just continues below the row as
        // smaller, grayer text, indented under the label.
        <div className="mb-2 pl-[22px] text-sm text-muted-foreground">
          {children}
        </div>
      )}
    </div>
  );
}
