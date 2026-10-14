// UUID v7 generation (Rust Uuid::now_v7 equivalent) and RFC 3339
// timestamp formatting that matches chrono's serde output: fractional
// seconds are trimmed to 0, 3, 6 or 9 digits (SecondsFormat::AutoSi).

import { createHash, randomBytes } from "node:crypto";

export function uuidv7(): string {
  const bytes = randomBytes(16);
  const ms = Date.now();
  bytes[0] = (ms / 2 ** 40) & 0xff;
  bytes[1] = (ms / 2 ** 32) & 0xff;
  bytes[2] = (ms / 2 ** 24) & 0xff;
  bytes[3] = (ms / 2 ** 16) & 0xff;
  bytes[4] = (ms / 2 ** 8) & 0xff;
  bytes[5] = ms & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** RFC 4122 name-based v5 (sha1) — the Rust `Uuid::new_v5` equivalent used
 *  by the deterministic tool-artifact ids. */
export function uuidv5(namespace: string, name: string): string {
  const nsBytes = Buffer.from(namespace.replaceAll("-", ""), "hex");
  const hash = createHash("sha1").update(nsBytes).update(name, "utf8").digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Normalizes a Postgres timestamp (microsecond text from to_char) into the
 * exact string chrono's serde produces for the same instant:
 * "YYYY-MM-DDTHH:MM:SS[.fff[fff[fff]]]Z" with the fraction kept in groups
 * of three digits, trailing zero groups dropped.
 */
export function pgTimestampToRfc3339(text: string): string {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/.exec(text);
  if (!m) throw new Error(`unexpected timestamp from Postgres: ${text}`);
  // Postgres gives microseconds; chrono's AutoSi prints the fraction in
  // groups of three with trailing zero groups dropped (0, 3, 6 or 9 digits).
  let fraction = "";
  if (m[2]) {
    const digits = m[2].replace(/0+$/, "");
    if (digits.length > 0) {
      const width = digits.length <= 3 ? 3 : 6;
      fraction = "." + digits.padEnd(width, "0");
    }
  }
  return `${m[1]}${fraction}Z`;
}
