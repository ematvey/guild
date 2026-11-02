/// Animated "Working" label: a bright band sweeps across the word via the
/// `.working-shimmer` class (theme.css) — background-clip:text over a
/// moving gradient, matching the reference shimmer.

export function WorkingIndicator({ label = "Working", className }: { label?: string; className?: string }) {
  return (
    <span aria-label={label} className={`text-sm ${className ? className : ""}`}>
      <span aria-hidden className="working-shimmer">
        {label}
      </span>
    </span>
  );
}
