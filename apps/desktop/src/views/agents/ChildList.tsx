// A block of consecutive child rows (decision 37): one indented, full-width
// list under the turn that spawned the children, with a compact header.
// Any non-child entry between two rows starts a new list.

import type { ViewEntry } from "../worked-for-block";
import type { ChildRow as ChildRowData } from "../../lib/thread-reducer";
import { ChildRow } from "./ChildRow";

export interface ChildListRow {
  key: string;
  row: ChildRowData;
}

export type ChildEntryGroup =
  | { kind: "child"; key: string; rows: ChildListRow[] }
  | { kind: "entry"; entry: ViewEntry; index: number };

function childRowOf(entry: ViewEntry): ChildListRow | null {
  if (entry.kind !== "plain" || entry.b.kind !== "tool") return null;
  const child = entry.b.tool?.child;
  return child ? { key: entry.b.key, row: child } : null;
}

/** Fold consecutive child rows into list groups; every other entry stays
 *  as its own group so the transcript keeps its order. */
export function groupChildEntries(entries: ViewEntry[]): ChildEntryGroup[] {
  const groups: ChildEntryGroup[] = [];
  let current: Extract<ChildEntryGroup, { kind: "child" }> | null = null;
  entries.forEach((entry, index) => {
    const child = childRowOf(entry);
    if (child) {
      if (current === null) {
        current = { kind: "child", key: `children-${child.key}`, rows: [] };
        groups.push(current);
      }
      current.rows.push(child);
      return;
    }
    current = null;
    groups.push({ kind: "entry", entry, index });
  });
  return groups;
}

export function ChildList({
  rows,
  onOpen,
}: {
  rows: ChildListRow[];
  onOpen: (chatId: string) => void;
}) {
  return (
    <div className="my-2 w-full">
      <div className="mb-1 flex items-center gap-2 pl-1 text-2xs font-semibold uppercase tracking-wider text-muted-foreground">
        <span>Subagents</span>
        <span className="tabular-nums">{rows.length}</span>
      </div>
      <div className="ml-1 border-l border-border pl-1.5">
        {rows.map(({ key, row }) => (
          <ChildRow key={key} row={row} onOpen={onOpen} />
        ))}
      </div>
    </div>
  );
}
