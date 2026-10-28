// Text that crosses a durable boundary must be storable. Postgres TEXT holds
// valid UTF-8, but U+0000 cannot enter a `jsonb` value, and a record is text
// that later queries may cast. Tool output can be binary, so the producers and
// the last write boundary replace U+0000 with the Unicode replacement
// character. Lone surrogates stay: the record is text, and no read path casts
// it anymore.

const NUL = "\u0000";
const REPLACEMENT = "\uFFFD";

export function sanitizeText(value: string): string {
  return value.includes(NUL) ? value.replaceAll(NUL, REPLACEMENT) : value;
}
