// Raw payload text in the same monospace block every tool body uses. A
// subagent request/result and a thinking trace are payloads, not prose, so
// they read like tool output instead of unstyled body text.

export function PayloadPre({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  return (
    <pre
      className={`max-h-64 overflow-y-auto whitespace-pre-wrap rounded-lg bg-muted px-3 py-2.5 font-mono text-sm leading-relaxed text-muted-foreground ${className}`}
    >
      {text}
    </pre>
  );
}
