//! Composer skill-mention detection: `/` at word start opens the skill
//! autocomplete (skills design §3 — the trigger replaced Codex's `$`).

export interface MentionSpan {
  /** Index of the `/` that opened the token. */
  start: number;
  /** Index just past the token (the caret when typing). */
  end: number;
  /** Typed fragment after the `/` (may be empty). */
  query: string;
}

/**
 * Detects an open `/name` mention ending at `caret`: the `/` must be at
 * text start or right after whitespace, and the token may contain only
 * lowercase letters, digits, and hyphens. Returns null when no token is
 * open at the caret (e.g. `https://…`, `a/b`, whitespace after the token).
 */
export function detectMention(text: string, caret: number): MentionSpan | null {
  // scan back over the token fragment (if any)
  let i = caret;
  while (i > 0 && /[a-z0-9-]/.test(text[i - 1])) i -= 1;
  // bare "/": the slash itself sits right before the caret
  if (i === caret) {
    const slash = caret - 1;
    if (slash < 0 || text[slash] !== "/") return null;
    if (slash > 0 && !/\s/.test(text[slash - 1])) return null;
    return { start: slash, end: caret, query: "" };
  }
  // token fragment consumed: the slash must sit right before it
  const slash = i - 1;
  if (slash < 0 || text[slash] !== "/") return null;
  if (slash > 0 && !/\s/.test(text[slash - 1])) return null;
  return { start: slash, end: caret, query: text.slice(i, caret) };
}

/** Replaces the open mention token with the picked skill and a trailing space. */
export function applyMention(text: string, caret: number, name: string): { text: string; caret: number } {
  const span = detectMention(text, caret);
  if (!span) return { text, caret };
  const insertion = `/${name} `;
  const next = text.slice(0, span.start) + insertion + text.slice(span.end);
  const nextCaret = span.start + insertion.length;
  return { text: next, caret: nextCaret };
}
