// Child rows come from the thread's child events and are pinned above the
// composer: the children of the current chat stay visible while the
// conversation scrolls, and the thread body keeps only the turn's text and
// tool cards. The panel collapses to its header, and the choice persists.

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@guild/ui/lib/utils";
import type { ChildRow as ChildRowData } from "../../lib/thread-reducer";
import { ChildRow } from "./ChildRow";

export interface ChildListRow {
  key: string;
  row: ChildRowData;
}

/** The collapsed choice outlives a reload; a browser without storage keeps
 *  the panel open. */
const COLLAPSED_KEY = "guild.subagentsCollapsed";

export function subagentsCollapsed(stored: string | null): boolean {
  return stored === "1";
}

function readCollapsed(): boolean {
  try {
    return subagentsCollapsed(localStorage.getItem(COLLAPSED_KEY));
  } catch {
    return false;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // A browser without storage keeps the choice for this session only.
  }
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
  const [collapsed, setCollapsed] = useState(readCollapsed);
  if (rows.length === 0) return null;
  const live = rows.filter((entry) => entry.row.status === "running" || entry.row.status === "queued").length;
  const toggle = () => {
    setCollapsed((prev) => {
      writeCollapsed(!prev);
      return !prev;
    });
  };
  return (
    <div className="w-full overflow-hidden rounded-xl border border-border/60 bg-muted/30">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-controls="subagent-rows"
        title={collapsed ? "Expand subagents" : "Collapse subagents"}
        className={cn(
          "flex w-full items-center gap-2 px-3 pb-1 pt-1.5 text-2xs font-semibold uppercase tracking-wider text-muted-foreground",
          "hover:text-foreground",
          collapsed && "pb-1.5",
        )}
      >
        {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
        <span>Subagents</span>
        <span className="tabular-nums">{rows.length}</span>
        {live > 0 && (
          <span className="flex items-center gap-1 normal-case tracking-normal text-sky-500">
            <span className="size-1.5 animate-pulse rounded-full bg-sky-500" />
            {live} running
          </span>
        )}
      </button>
      {!collapsed && (
        <div id="subagent-rows" className="max-h-56 overflow-y-auto px-1.5 pb-1.5">
          {rows.map(({ key, row }) => (
            <ChildRow key={key} row={row} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}
