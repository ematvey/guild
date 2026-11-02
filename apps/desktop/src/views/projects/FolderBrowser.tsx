// The shared folder-browser body: an unfiltered listing, a `~`-expanding
// path field, Enter jumps into a typed path or descends the highlighted row,
// and breadcrumb up-navigation. The browse state machine is pure
// (./projects.ts). Each specifier supplies its own listing transport and
// path adapter; the body owns only the interaction.

import { useEffect, useReducer, useRef, useState } from "react";
import { ChevronRight, CornerDownLeft, Folder, FolderOpen } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { SkeletonRows } from "@guild/ui/components/skeleton";
import type { DirEntry } from "../../lib/api/folders";
import { displayPath, expandError, expandPath, linuxBreadcrumbs, pickerReducer, pickerFor } from "./projects";

export function FolderBrowser({
  source,
  home,
  list,
  canonical,
  errorSuffix,
  existingFor,
  onConfirm,
}: {
  /** The source key for the browse state and the breadcrumb root label. */
  source: string;
  /** The source's home directory (inner Linux path). */
  home: () => Promise<string | null>;
  /** Lists one inner path. */
  list: (path: string) => Promise<DirEntry[]>;
  /** Converts an inner Linux path into the folder the caller stores. */
  canonical: (inner: string) => string;
  /** Extra text after a listing error (the WSL distro hint). */
  errorSuffix?: (error: string) => string;
  /** Matches a folder against the caller's existing projects — the Confirm
   * button reads "Open project" when the browsed folder is one. */
  existingFor?: (folder: string) => unknown;
  /** Called with the confirmed folder. */
  onConfirm: (folder: string) => void;
}) {
  // The browse state lives in inner Linux paths; the canonical stored form
  // exists only at the edges — listing calls and the confirmed folder.
  const [state, dispatch] = useReducer(pickerReducer, undefined, () => pickerFor(source, "/"));
  const [homeLinux, setHomeLinux] = useState<string | null>(null);
  // The path field holds the DISPLAY form (~-shortened); empty means the
  // user has not typed, so Enter descends the highlighted row.
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef(list);
  listRef.current = list;

  // ~ expansion needs the source's home (LINUX $HOME), fetched once.
  useEffect(() => {
    let dead = false;
    void home()
      .then((h) => {
        if (!dead && h) setHomeLinux(h);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [source]);

  // Listing effect: every cwd change lists through the source transport.
  // Only a result for the CURRENT cwd lands (the reducer drops stale ones).
  useEffect(() => {
    if (!state.cwd) return;
    const path = state.cwd;
    dispatch({ type: "loading", path });
    let dead = false;
    void listRef
      .current(path)
      .then((entries) => {
        if (!dead) dispatch({ type: "loaded", path, entries });
      })
      .catch((e) => {
        if (!dead)
          dispatch({
            type: "failed",
            path,
            error: e instanceof Error ? e.message : String(e),
          });
      });
    return () => {
      dead = true;
    };
  }, [state.cwd, source]);

  // The field mirrors the view's path until the user types over it.
  useEffect(() => {
    setTyped(state.cwd ? displayPath(state.cwd, homeLinux) : "");
  }, [state.cwd, homeLinux]);

  const confirmable = state.entries !== null && state.cwd !== null;
  const dirty = state.cwd !== null && typed !== displayPath(state.cwd, homeLinux);

  const commitInput = () => {
    if (!dirty) {
      dispatch({ type: "descend" });
      return;
    }
    // A bare `~` with an unavailable home is an error, not a descend.
    const err = expandError(typed, homeLinux);
    if (err) {
      dispatch({ type: "error", message: err });
      return;
    }
    const path = expandPath(typed, homeLinux);
    if (path) dispatch({ type: "go", path });
    else dispatch({ type: "descend" });
  };

  const crumbs = state.cwd ? linuxBreadcrumbs(source, state.cwd) : [];

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
      <input
        ref={inputRef}
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commitInput();
          } else if (e.key === "ArrowDown") {
            e.preventDefault();
            dispatch({
              type: "highlight",
              index: Math.min(state.highlight + 1, (state.entries?.length ?? 1) - 1),
            });
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            dispatch({ type: "highlight", index: Math.max(0, state.highlight - 1) });
          }
        }}
        placeholder={homeLinux ? "~" : "/"}
        className="w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm outline-none focus:ring-1 focus:ring-ring"
        title="Type a path (~ = home), Enter to jump in"
      />
      <div className="flex items-center gap-0.5 overflow-x-auto text-xs">
        {crumbs.map((c, i) => (
          <span key={c.path} className="flex shrink-0 items-center">
            {i > 0 && <ChevronRight className="size-3 text-muted-foreground/50" />}
            <button
              type="button"
              className={`rounded px-1 py-0.5 hover:bg-accent ${
                i === crumbs.length - 1 ? "font-medium text-foreground" : "text-muted-foreground"
              }`}
              onClick={() => dispatch({ type: "go", path: c.path })}
            >
              {c.label}
            </button>
          </span>
        ))}
        {crumbs.length > 0 && (
          <button
            type="button"
            title="Up one level"
            className="ml-1 shrink-0 rounded px-1 py-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => dispatch({ type: "up" })}
          >
            ↑
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-md border border-border">
        {state.entries === null && !state.error && <SkeletonRows />}
        {state.error && (
          <div className="p-3 text-muted-foreground">
            {state.error}
            {errorSuffix?.(state.error) ?? ""}
          </div>
        )}
        {state.entries !== null && state.entries.length === 0 && (
          <p className="p-3 text-muted-foreground">Empty folder.</p>
        )}
        <div className="p-1">
          {state.entries?.map((entry, i) => (
            <button
              key={entry.name}
              type="button"
              disabled={!entry.is_dir}
              onMouseEnter={() => dispatch({ type: "highlight", index: i })}
              onClick={() => {
                dispatch({ type: "highlight", index: i });
                if (entry.is_dir) dispatch({ type: "descend" });
              }}
              className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm outline-none ${
                i === state.highlight ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent"
              } ${entry.is_dir ? "" : "opacity-50"}`}
            >
              {entry.is_dir ? (
                i === state.highlight ? (
                  <FolderOpen className="size-3.5 shrink-0" />
                ) : (
                  <Folder className="size-3.5 shrink-0" />
                )
              ) : (
                <span className="size-3.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span
          className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
          title={canonical(state.cwd ?? "/")}
        >
          {state.cwd}
        </span>
        <Button
          size="sm"
          disabled={!confirmable}
          onClick={() => state.cwd && onConfirm(canonical(state.cwd))}
          title={confirmable ? "Use this folder" : "Navigate to a folder first"}
        >
          <CornerDownLeft className="size-3.5" />
          {(() => {
            if (!confirmable) return "Confirm";
            const folder = canonical(state.cwd!);
            return existingFor?.(folder) ? "Open project" : "Create project";
          })()}
        </Button>
      </div>
    </div>
  );
}
