//! FactCard — a labelled fact on a detail page (read-only data as cards, the
//! existing "facts first, explicit edit" convention). Facts lay out in a
//! responsive card grid via FactGrid.

import type { ReactNode } from "react";
import { cn } from "@guild/ui/lib/utils";

export function FactCard({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border border-border bg-card p-4", className)}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <div className="mt-2 text-base">{children}</div>
    </div>
  );
}

export function FactGrid({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("grid gap-3 sm:grid-cols-2", className)}>{children}</div>;
}
