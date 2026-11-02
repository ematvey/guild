import { cn } from "../lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden="true"
      data-slot="skeleton"
      className={cn("motion-safe:animate-pulse rounded bg-muted-foreground/10", className)}
      {...props}
    />
  );
}

/** A compact content placeholder. Keep labels and surrounding layout visible. */
function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div role="status" aria-label="Loading content" className={cn("space-y-2.5", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-3 max-w-full", i === lines - 1 ? "w-2/5" : i % 2 ? "w-3/5" : "w-4/5")} />
      ))}
    </div>
  );
}

function SkeletonRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div role="status" aria-label="Loading content" className={cn("divide-y divide-border/50", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-11 items-center gap-3 px-3">
          <Skeleton className={cn("h-3 max-w-full", i % 2 ? "w-28" : "w-36")} />
          <Skeleton className="ml-auto h-3 w-16" />
        </div>
      ))}
    </div>
  );
}

function SkeletonForm({ className }: { className?: string }) {
  return (
    <div role="status" aria-label="Loading settings" className={cn("max-w-xl space-y-5 py-2", className)}>
      <Skeleton className="h-5 w-36" />
      {[0, 1, 2].map((i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-3 w-24" />
          <div className="flex h-9 items-center rounded-md border border-border px-3">
            <Skeleton className={cn("h-3", i % 2 ? "w-2/5" : "w-3/5")} />
          </div>
        </div>
      ))}
    </div>
  );
}

export { Skeleton, SkeletonText, SkeletonRows, SkeletonForm };
