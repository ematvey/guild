// Child rows are collected from the transcript and pinned above the composer:
// the children of the current chat stay visible while the conversation
// scrolls, and the thread body keeps only the turn's text and tool cards.

import type { ViewEntry } from "../worked-for-block";
import type { ChildRow as ChildRowData } from "../../lib/thread-reducer";
import { ChildRow } from "./ChildRow";

export interface ChildListRow {
  key: string;
  row: ChildRowData;
}

function childRowOf(entry: ViewEntry): ChildListRow | null {
  if (entry.kind !== "plain" || entry.b.kind !== "tool") return null;
  const child = entry.b.tool?.child;
  return child ? { key: entry.b.key, row: child } : null;
}

/** Every child row in transcript order, deduped by thread id: a
 *  `child_result` can repeat a spawn's row, and the newest copy wins. A row
 *  from a nested spawn has no thread id yet, so its block key stands in. */
export function childRowsOf(entries: ViewEntry[]): ChildListRow[] {
  const rows = new Map<string, ChildListRow>();
  for (const entry of entries) {
    const child = childRowOf(entry);
    if (!child) continue;
    const id = child.row.threadId === "" ? child.key : child.row.threadId;
    rows.delete(id);
    rows.set(id, { key: id, row: child.row });
  }
  return [...rows.values()];
}

export function ChildList({
  rows,
  onOpen,
}: {
  rows: ChildListRow[];
  onOpen: (chatId: string) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="w-full overflow-hidden rounded-xl border border-border/60 bg-muted/30">
      <div className="flex items-center gap-2 px-3 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Subagents</span>
        <span className="tabular-nums">{rows.length}</span>
      </div>
      <div className="max-h-56 overflow-y-auto px-1.5 pb-1.5">
        {rows.map(({ key, row }) => (
          <ChildRow key={key} row={row} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}
