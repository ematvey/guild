// Formatting for the compact subagent row. Pure functions only; the row's
// elapsed clock is computed on the client from the run's started_at.

import type { ChildRow } from "../../lib/thread-reducer";

/** "0s", "42s", "3m 07s", "2h 05m" — compact, one unit pair at most. */
export function childElapsedLabel(row: ChildRow, now: number = Date.now()): string {
  const start = Date.parse(row.startedAt);
  if (Number.isNaN(start)) return "";
  const end = row.finishedAt ? Date.parse(row.finishedAt) : now;
  if (Number.isNaN(end)) return "";
  const seconds = Math.max(0, Math.floor((end - start) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export type ChildStatusTone = "running" | "success" | "danger" | "muted";

export function childStatusTone(status: string): ChildStatusTone {
  if (status === "running" || status === "queued") return "running";
  if (status === "succeeded") return "success";
  if (status === "failed") return "danger";
  return "muted";
}

export function childStatusLabel(status: string): string {
  if (status === "succeeded") return "Succeeded";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  if (status === "running") return "Running";
  if (status === "queued") return "Queued";
  if (status === "silent") return "Silent";
  if (status === "skipped") return "Skipped";
  return status;
}

/** A child row navigates only to a real chat id. A thread id is not a chat
 *  id, so a row without one stays inert. */
export function openChildChat(row: ChildRow, onOpen: (chatId: string) => void): void {
  const chatId = row.chatId ?? null;
  if (chatId) onOpen(chatId);
}

/** The row click and the chevron both open the child chat. One handler
 *  pair keeps the two activations on the same inert rule. */
export function childRowOpeners(
  row: ChildRow,
  onOpen: (chatId: string) => void,
): { row: () => void; chevron: () => void } {
  const open = () => openChildChat(row, onOpen);
  return { row: open, chevron: open };
}
