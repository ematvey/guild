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

/** The Active/All choice outlives a reload; active only is the default. */
const ACTIVE_ONLY_KEY = "guild.subagentsActiveOnly";

export function subagentsCollapsed(stored: string | null): boolean {
  return stored === "1";
}

export function subagentsActiveOnly(stored: string | null): boolean {
  return stored !== "0";
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

function readActiveOnly(): boolean {
  try {
    return subagentsActiveOnly(localStorage.getItem(ACTIVE_ONLY_KEY));
  } catch {
    return true;
  }
}

function writeActiveOnly(activeOnly: boolean): void {
  try {
    localStorage.setItem(ACTIVE_ONLY_KEY, activeOnly ? "1" : "0");
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
  const [activeOnly, setActiveOnly] = useState(readActiveOnly);
  if (rows.length === 0) return null;
  const live = rows.filter((entry) => entry.row.status === "running" || entry.row.status === "queued").length;
  const visible = activeOnly
    ? rows.filter((entry) => entry.row.status !== "closed")
    : rows;
  const toggle = () => {
    setCollapsed((prev) => {
      writeCollapsed(!prev);
      return !prev;
    });
  };
  const setMode = (nextActiveOnly: boolean) => {
    writeActiveOnly(nextActiveOnly);
    setActiveOnly(nextActiveOnly);
  };
  const switchClass = (selected: boolean) =>
    cn(
      "rounded px-1 py-0.5 normal-case tracking-normal transition-colors",
      selected ? "text-foreground" : "text-muted-foreground/70 hover:text-foreground",
    );
  return (
    <div className="w-full overflow-hidden rounded-xl border border-border/60 bg-muted/30">
      <div className={cn("flex w-full items-center gap-2 px-3 pb-1 pt-1.5", collapsed && "pb-1.5")}>
        <button
          type="button"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-controls="subagent-rows"
          title={collapsed ? "Expand subagents" : "Collapse subagents"}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-2 text-2xs font-semibold uppercase tracking-wider text-muted-foreground",
            "hover:text-foreground",
          )}
        >
          {collapsed ? <ChevronRight className="size-3" /> : <ChevronDown className="size-3" />}
          <span>Subagents</span>
          <span className="tabular-nums">{visible.length}</span>
          {live > 0 && (
            <span className="flex items-center gap-1 normal-case tracking-normal text-sky-500">
              <span className="size-1.5 animate-pulse rounded-full bg-sky-500" />
              {live} running
            </span>
          )}
        </button>
        <div
          role="group"
          aria-label="Subagent filter"
          className="flex shrink-0 items-center gap-0.5 text-2xs font-semibold uppercase tracking-wider"
        >
          <button
            type="button"
            aria-pressed={activeOnly}
            onClick={(e) => {
              e.stopPropagation();
              setMode(true);
            }}
            className={switchClass(activeOnly)}
          >
            Active
          </button>
          <span aria-hidden="true" className="text-muted-foreground/50">|</span>
          <button
            type="button"
            aria-pressed={!activeOnly}
            onClick={(e) => {
              e.stopPropagation();
              setMode(false);
            }}
            className={switchClass(!activeOnly)}
          >
            All
          </button>
        </div>
      </div>
      {!collapsed && (
        <div id="subagent-rows" className="max-h-56 overflow-y-auto px-1.5 pb-1.5">
          {visible.length === 0 ? (
            <p className="px-1.5 py-1 text-2xs text-muted-foreground">No active subagents</p>
          ) : (
            visible.map(({ key, row }) => (
              <ChildRow key={key} row={row} onOpen={onOpen} />
            ))
          )}
        </div>
      )}
    </div>
  );
}
