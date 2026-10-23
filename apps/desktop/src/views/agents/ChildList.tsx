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

/** Every child row in transcript order, one row per child. A spawn call
 *  inside a codemode script reports its target before the child has a thread
 *  id; the later `child_result` supplies the id, chat, title and status, so
 *  the two are merged instead of listed twice. Rows are matched by agent name
 *  in arrival order, then by thread id. */
export function childRowsOf(entries: ViewEntry[]): ChildListRow[] {
  const rows: ChildListRow[] = [];
  const pending = new Map<string, number>();
  for (const entry of entries) {
    const child = childRowOf(entry);
    if (!child) continue;
    const row = child.row;
    if (row.threadId === "") {
      const existing = pending.get(row.agentName);
      if (existing === undefined) {
        pending.set(row.agentName, rows.length);
        rows.push({ key: child.key, row });
      } else {
        rows[existing] = { key: rows[existing]!.key, row: { ...rows[existing]!.row, ...row } };
      }
      continue;
    }
    const waiting = pending.get(row.agentName);
    if (waiting !== undefined) {
      pending.delete(row.agentName);
      rows[waiting] = { key: rows[waiting]!.key, row: { ...rows[waiting]!.row, ...row } };
      continue;
    }
    const known = rows.findIndex((candidate) => candidate.row.threadId === row.threadId);
    if (known >= 0) {
      rows[known] = { key: rows[known]!.key, row: { ...rows[known]!.row, ...row } };
    } else {
      rows.push({ key: row.threadId, row });
    }
  }
  return rows;
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
