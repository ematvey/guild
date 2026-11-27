// The status mark beside an installed integration: amber needs setup, red
// failing, green active, hollow off or idle.

import type { InstalledStatus } from "./model";

const TONE: Record<InstalledStatus["kind"], string> = {
  needs_setup: "bg-amber-500",
  failing: "bg-destructive",
  active: "bg-emerald-500",
  idle: "border border-emerald-500/70",
  disabled: "border border-muted-foreground/50",
};

export function StatusDot({ status }: { status: InstalledStatus }) {
  return <span aria-hidden className={`inline-block size-2 shrink-0 rounded-full ${TONE[status.kind]}`} />;
}
