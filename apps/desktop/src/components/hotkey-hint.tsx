// Hotkey badge for tooltips: platform-aware modifier glyph (⌘ on Apple,
// Ctrl elsewhere) with the keys in small bordered chips. Pair with the
// command name inside a TooltipContent. A combo is "+"-separated; the
// special part "mod" renders as the platform modifier. When `browserCombo`
// is set it replaces `combo` outside the desktop client (browsers reserve
// some plain-modifier shortcuts, e.g. Ctrl+N).

import { HAS_SHELL } from "../lib/session";

const isApple =
  typeof navigator !== "undefined" &&
  (/Mac|iPhone|iPad/.test(navigator.platform ?? "") || /Mac/.test(navigator.userAgent ?? ""));

/** The platform's modifier label for a Ctrl/Cmd combo. */
export function modKey(): "⌘" | "Ctrl" {
  return isApple ? "⌘" : "Ctrl";
}

const chip =
  "rounded border border-border bg-muted px-1 font-sans text-xs font-medium leading-5 text-muted-foreground";

export function HotkeyHint({ combo, browserCombo }: { combo: string; browserCombo?: string }) {
  const parts = (HAS_SHELL ? combo : browserCombo ?? combo).split("+");
  return (
    <span className="ml-2 inline-flex items-center gap-0.5">
      {parts.map((part) => (
        <kbd key={part} className={chip}>
          {part === "mod" ? modKey() : part}
        </kbd>
      ))}
    </span>
  );
}
