/** Coarse relative time for "last seen" stamps: "just now", "5m ago",
 * "3h ago", "12d ago". Pure — `now` is injectable so it can be tested. */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.max(0, Math.floor((now - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Future-facing relative time for a schedule: "in 8h" for the same day,
 *  otherwise a short date. A stamp at or before `now` reads "due now". */
export function nextRunLabel(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.floor((then - now) / 1000);
  if (seconds <= 0) return "due now";
  if (seconds < 3600) return `in ${Math.max(1, Math.floor(seconds / 60))}m`;
  if (seconds < 86_400) return `in ${Math.floor(seconds / 3600)}h`;
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
