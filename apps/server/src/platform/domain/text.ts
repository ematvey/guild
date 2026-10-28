// Text that crosses a durable boundary must be storable. Postgres TEXT holds
// valid UTF-8, but U+0000 cannot enter a `jsonb` value, and a record is text
// that later queries may cast. Tool output can be binary, so the producers and
// the last write boundary replace U+0000 with the Unicode replacement
// character. Lone surrogates stay in a record column: the record is text, and
// no read path casts it. A jsonb column rejects them too, so its encoder makes
// the text well-formed first.
//
// A key is text as well: jsonb rejects U+0000 and a lone surrogate in a
// property name exactly as it rejects them in a value, and a JSON replacer
// never visits a key. The cleaners below rebuild every object, so keys and
// values take the same path.

const NUL = "\u0000";
const REPLACEMENT = "\uFFFD";

export function sanitizeText(value: string): string {
  return value.includes(NUL) ? value.replaceAll(NUL, REPLACEMENT) : value;
}

/** Rebuilds a JSON value with every string, key and value made storable.
 *  `wellFormed` also repairs a lone surrogate (for a jsonb column). */
function cleanJson(value: unknown, wellFormed: boolean): unknown {
  if (typeof value === "string") {
    const text = sanitizeText(value);
    return wellFormed ? text.toWellFormed() : text;
  }
  if (Array.isArray(value)) return value.map((item) => cleanJson(item, wellFormed));
  if (value !== null && typeof value === "object") {
    // A null prototype keeps a `__proto__` key an own property instead of
    // setting the object's prototype.
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [key, item] of Object.entries(value)) {
      const name = sanitizeText(key);
      out[wellFormed ? name.toWellFormed() : name] = cleanJson(item, wellFormed);
    }
    return out;
  }
  return value;
}

/** The value a store keeps after sanitization. A retry must compare against
 *  this form, not the raw input, or a NUL makes a valid retry a conflict. */
export function jsonValue(value: unknown): unknown {
  return cleanJson(value, false);
}

/** JSON text for a record (TEXT) column. */
export function recordJsonText(value: unknown): string {
  return JSON.stringify(cleanJson(value, false));
}

/** JSON text for a jsonb column or a `::jsonb` parameter. Postgres jsonb
 *  rejects U+0000 and a lone surrogate in a key or a value. Clean input
 *  passes through byte-identical. */
export function jsonbText(value: unknown): string {
  return JSON.stringify(cleanJson(value, true));
}
