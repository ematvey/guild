// One parser and one formatter for a skill version. The server stores its
// computed versions as counters ("v1") while users publish semver
// ("0.1.0"); both shapes parse here and format with one "v" prefix.

export interface ParsedVersion {
  /** The bare version text, without a leading "v". */
  text: string;
  /** Numeric segments, in order. */
  parts: number[];
}

/** Parses "v3", "3" and "0.1.0"; null when the text is not numeric. */
export function parseVersion(version: string): ParsedVersion | null {
  const text = version.trim().replace(/^v/i, "");
  if (!/^\d+(?:\.\d+)*$/.test(text)) return null;
  return { text, parts: text.split(".").map(Number) };
}

/** Renders a version with exactly one "v" prefix. */
export function formatVersion(version: string): string {
  const parsed = parseVersion(version);
  return `v${parsed?.text ?? version.trim().replace(/^v/i, "")}`;
}

/** Numeric version order; missing segments count as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)?.parts ?? [];
  const pb = parseVersion(b)?.parts ?? [];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** The first numeric segment, for a coarse rank. */
export function versionRank(version: string): number {
  return parseVersion(version)?.parts[0] ?? 0;
}
