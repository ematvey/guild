export function Caret({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={
        "ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.18em] animate-caret rounded-full bg-foreground" +
        (className ? ` ${className}` : "")
      }
    />
  );
}
