// Child rows come from the thread's child events and are pinned above the
// composer: the children of the current chat stay visible while the
// conversation scrolls, and the thread body keeps only the turn's text and
// tool cards.

import type { ChildRow as ChildRowData } from "../../lib/thread-reducer";
import { ChildRow } from "./ChildRow";

export interface ChildListRow {
  key: string;
  row: ChildRowData;
}

/** Every child row in spawn order, one row per child thread. A row without a
 *  chat id is not rendered: there is nothing to open. */
export function childRowsOf(children: ChildRowData[]): ChildListRow[] {
  const rows: ChildListRow[] = [];
  const indexByThread = new Map<string, number>();
  for (const row of children) {
    const existing = indexByThread.get(row.threadId);
    if (existing === undefined) {
      indexByThread.set(row.threadId, rows.length);
      rows.push({ key: row.threadId, row });
    } else {
      rows[existing] = { key: rows[existing]!.key, row: { ...rows[existing]!.row, ...row } };
    }
  }
  return rows.filter((entry) => !!entry.row.chatId);
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
