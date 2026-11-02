import type { ReactNode } from "react";
import { Inbox, type LucideIcon } from "lucide-react";

import { cn } from "../lib/utils";

/** The standard "nothing here yet" block for a list, a page or a card: an
 *  icon, a heading, an optional hint and an optional action. */
function EmptyState({
  icon: Icon = Inbox,
  title,
  hint,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-border bg-card/40 px-6 py-12 text-center",
        className,
      )}
    >
      <div className="mb-3 flex size-11 items-center justify-center rounded-full border border-border bg-background text-muted-foreground">
        <Icon className="size-5" />
      </div>
      <p className="text-lg font-semibold tracking-tight">{title}</p>
      {hint !== undefined && <div className="mt-1 max-w-md text-sm text-muted-foreground">{hint}</div>}
      {action !== undefined && <div className="mt-4">{action}</div>}
    </div>
  );
}

export { EmptyState };
