// Text that crosses a durable boundary must be storable. Postgres TEXT holds
// valid UTF-8, but U+0000 cannot enter a `jsonb` value, and a record is text
// that later queries may cast. Tool output can be binary, so the producers and
// the last write boundary replace U+0000 with the Unicode replacement
// character. Lone surrogates stay in a record column: the record is text, and
// no read path casts it. A jsonb column rejects them too, so its encoder makes
// the text well-formed first.

const NUL = "\u0000";
const REPLACEMENT = "\uFFFD";

export function sanitizeText(value: string): string {
  return value.includes(NUL) ? value.replaceAll(NUL, REPLACEMENT) : value;
}

/** JSON text for a record (TEXT) column. */
export function recordJsonText(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "string" ? sanitizeText(item) : item);
}

/** JSON text for a jsonb column or a `::jsonb` parameter. Postgres jsonb
 *  rejects U+0000 and a lone surrogate. JSON.stringify escapes a lone
 *  surrogate as \udXXX and leaves U+0000 in the text, so every string goes
 *  through the record-text sanitizer and is made well-formed first. Clean
 *  input passes through byte-identical. */
export function jsonbText(value: unknown): string {
  return JSON.stringify(value, (_key, item) =>
    typeof item === "string" ? sanitizeText(item).toWellFormed() : item);
}
