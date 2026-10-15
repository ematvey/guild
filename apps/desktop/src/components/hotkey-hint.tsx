// Hotkey badge for tooltips: platform-aware modifier glyph (⌘ on Apple,
// Ctrl elsewhere) with the key in a small bordered chip. Pair with the
// command name inside a TooltipContent.

const isApple =
  typeof navigator !== "undefined" &&
  (/Mac|iPhone|iPad/.test(navigator.platform ?? "") || /Mac/.test(navigator.userAgent ?? ""));

/** The platform's modifier label for a Ctrl/Cmd combo. */
export function modKey(): "⌘" | "Ctrl" {
  return isApple ? "⌘" : "Ctrl";
}

export function HotkeyHint({ combo }: { combo: string }) {
  const [mod, key] = combo.split("+");
  return (
    <span className="ml-2 inline-flex items-center gap-0.5">
      <kbd className="rounded border border-border bg-muted px-1 font-sans text-[10px] font-medium leading-4 text-muted-foreground">
        {mod === "mod" ? modKey() : mod}
      </kbd>
      <kbd className="rounded border border-border bg-muted px-1 font-sans text-[10px] font-medium leading-4 text-muted-foreground">
        {key}
      </kbd>
    </span>
  );
}
