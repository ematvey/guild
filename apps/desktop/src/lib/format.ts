/** Human byte size for UI rows. `binary` selects KiB/MiB units for values
 *  the server reports in binary units (release artifact sizes). */
export function formatBytes(bytes: number | null | undefined, opts: { binary?: boolean } = {}): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return "—";
  const unit = opts.binary ? "iB" : "B";
  const step = 1024;
  if (bytes < step) return `${bytes} B`;
  if (bytes < step * step) {
    return `${(bytes / step).toFixed(bytes < 10 * step ? 1 : 0)} K${unit}`;
  }
  if (bytes < step ** 3) {
    return `${(bytes / step ** 2).toFixed(bytes < 10 * step ** 2 ? 1 : 0)} M${unit}`;
  }
  return `${(bytes / step ** 3).toFixed(1)} G${unit}`;
}

/** First two characters of a label, uppercased — the avatar chip fallback
 *  for an owner or account without a photo. */
export function avatarChip(label: string): string {
  return label.slice(0, 2).toUpperCase();
}

/** Compact elapsed time for a running clock: the largest unit down to the
 *  second — `7s`, `1m 23s`, `2h 5m 0s`, `1d 0h 0m 9s`. */
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const parts = [
    [Math.floor(s / 86_400), "d"],
    [Math.floor(s / 3600) % 24, "h"],
    [Math.floor(s / 60) % 60, "m"],
    [s % 60, "s"],
  ] as const;
  const first = parts.findIndex(([n]) => n > 0);
  const kept = first === -1 ? parts.slice(3) : parts.slice(first);
  return kept.map(([n, unit]) => `${n}${unit}`).join(" ");
}

/** `1 agent`, `3 agents` — the one plural rule in the client. */
export const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
