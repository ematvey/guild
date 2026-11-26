// A full main-column page under the rail, with the mobile bar that opens
// the drawer (a route page has no drawer control of its own).
import type { ReactNode } from "react";
import { ChevronRight, Menu } from "lucide-react";
import { Button } from "@guild/ui/components/button";

/** Mobile: a route page has no drawer control of its own, so it gets this
 *  bar. The chat view carries the drawer button in its own header. */
export function MobileNavBar({ onOpenDrawer, title }: { onOpenDrawer: () => void; title?: string }) {
  return (
    <header className="flex items-center gap-2 border-b border-border px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))] text-base">
      <Button
        variant="ghost"
        size="icon"
        className="-ml-1.5 size-9 pointer-coarse:size-10"
        onClick={onOpenDrawer}
        aria-label="Open sidebar"
      >
        <Menu />
      </Button>
      {title !== undefined && <span className="min-w-0 flex-1 truncate font-medium">{title}</span>}
    </header>
  );
}

/** A route page under the mobile bar. */
export function RoutePage({
  isMobile,
  title,
  onOpenDrawer,
  children,
}: {
  isMobile: boolean;
  title?: string;
  onOpenDrawer: () => void;
  children: ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background md:m-2 md:rounded-xl md:border md:border-border"
    >
      {isMobile ? (
        <MobileNavBar onOpenDrawer={onOpenDrawer} title={title} />
      ) : (
        title && (
          <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-5 text-sm">
            <span className="text-muted-foreground">Work</span>
            <ChevronRight className="size-3.5 text-muted-foreground" aria-hidden="true" />
            <span className="font-medium">{title}</span>
          </header>
        )
      )}
      {children}
    </section>
  );
}
