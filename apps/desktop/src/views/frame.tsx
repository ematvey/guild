// The transcript's collapsible block: a clickable text row on the page with
// no chip background, and its content below once opened. Tools, reasoning,
// approvals and subagent records all use it, so a record in the thread looks
// the same whatever it carries.

import { useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";

/// The row that every transcript detail shares: tools, reasoning, subagent
/// records and the agent-work group itself. One class keeps their vertical
/// rhythm identical wherever they nest.
export const FRAME_ROW_CLASS =
  "flex w-full items-center gap-2 py-1 text-left outline-none transition-colors hover:text-foreground";

/// The body below an opened row: smaller, grayer, indented under the label.
export const FRAME_BODY_CLASS = "mb-2 pl-[22px] text-sm text-muted-foreground";

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
        className={FRAME_ROW_CLASS}
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
        <div className={FRAME_BODY_CLASS}>
          {children}
        </div>
      )}
    </div>
  );
}
