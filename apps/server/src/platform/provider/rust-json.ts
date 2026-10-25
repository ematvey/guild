// serde_json-compatible text rendering: sorted keys, ryu float form, and
// the RustFloat marker for integral floats that must keep a ".0" tail.

/** Formats a parsed JSON value the way serde_json renders a Value (BTreeMap
 *  key order) — used wherever parsed provider values are re-encoded. */
export function serializeRustJson(value: unknown): string {
  return rustJsonText(value);
}

export interface RustFloat {
  readonly __rustFloat: number;
}

/** Marks a value that must serialize as an f64 (ryu rules: integral floats
 *  keep a ".0" tail) even when it holds an integral number — serde's
 *  integer fields render plain, floats never lose their ".0". */
export function rustFloat(n: number): RustFloat {
  return { __rustFloat: n };
}

export function rustJsonText(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    // Integers render plain; fractions get their shortest form.
    return Number.isInteger(value) ? String(value) : String(value).replace("e+", "e");
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "object" && "__rustFloat" in value) {
    return rustFloatText((value as RustFloat).__rustFloat);
  }
  if (Array.isArray(value)) return `[${value.map(rustJsonText).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${rustJsonText((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** serde_json's ryu rendering for f64 values. */
export function rustFloatText(n: number): string {
  if (!Number.isFinite(n)) return "null"; // serde_json: non-finite → null
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return `${n.toFixed(1)}`;
  return String(n).replace("e+", "e");
}


