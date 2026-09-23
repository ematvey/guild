/// Animated "Working" label: a brightness wave sweeps across the letters,
/// staged via per-letter animation-delay over the shared
/// `animate-working-shimmer` keyframes (theme.css).

export function WorkingIndicator({
  label = "Working",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <span
      aria-label={label}
      className={
        "text-sm " + (className ? className : "")
      }
    >
      {label.split("").map((ch, i) => (
        <span
          key={i}
          aria-hidden
          className="inline-block animate-working-shimmer"
          style={{ animationDelay: `${i * 110}ms` }}
        >
          {ch === " " ? "\u00A0" : ch}
        </span>
      ))}
      <span
        aria-hidden
        className="inline-block animate-working-shimmer text-muted-foreground"
        style={{ animationDelay: `${label.length * 110}ms` }}
      >
        …
      </span>
    </span>
  );
}
