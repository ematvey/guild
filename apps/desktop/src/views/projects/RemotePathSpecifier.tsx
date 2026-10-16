// In-app folder browser for a REMOTE machine (the create-project dialog's
// path specifier): same browse UX as the WSL specifier, but the listing
// goes browser → server → machine socket (read-only control-plane op) and
// the paths are the machine's own Linux paths — no UNC layer.

import { useEffect, useReducer, useRef, useState } from "react";
import { ChevronRight, CornerDownLeft, Folder, FolderOpen } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { SkeletonRows } from "@guild/ui/components/skeleton";
import { listRemoteDir, remoteHome } from "../../transport";
import {
  displayPath,
  expandError,
  expandPath,
  linuxBreadcrumbs,
  linuxCanonical,
  pickerReducer,
  pickerFor,
} from "./projects";

export function RemotePathSpecifier({
  machineId,
  existingFor,
  onConfirm,
}: {
  machineId: string;
  /** Matches a folder against the caller's existing projects — the Confirm
   * button reads "Open project" when the browsed folder is one. */
  existingFor?: (folder: string) => unknown;
  /** Called with the confirmed folder (canonical Linux path). */
  onConfirm: (folder: string) => void;
}) {
  // Same pure browse state machine as the WSL specifier; the source is the
  // machine id and the inner paths are the machine's Linux paths.
  const [state, dispatch] = useReducer(
    pickerReducer,
    undefined,
    () => pickerFor(machineId, "/"),
  );
  const [homeLinux, setHomeLinux] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // ~ expansion needs the machine's home (LINUX $HOME), fetched once.
  useEffect(() => {
    let dead = false;
    void remoteHome(machineId)
      .then((home) => {
        if (!dead) setHomeLinux(home);
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [machineId]);

  // Listing effect: every cwd change lists through the server. Only a
  // result for the CURRENT cwd lands (the reducer drops stale ones).
  useEffect(() => {
    if (!state.cwd) return;
    const path = state.cwd;
    dispatch({ type: "loading", path });
    let dead = false;
    void listRemoteDir(machineId, path)
      .then((entries) => {
        if (!dead) dispatch({ type: "loaded", path, entries });
      })
      .catch((e) => {
        if (!dead) dispatch({ type: "failed", path, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      dead = true;
    };
  }, [state.cwd, machineId]);

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
    const err = expandError(typed, homeLinux);
    if (err) {
      dispatch({ type: "error", message: err });
      return;
    }
    const path = expandPath(typed, homeLinux);
    if (path) dispatch({ type: "go", path: linuxCanonical(path) });
    else dispatch({ type: "descend" });
  };

  const crumbs = state.cwd ? linuxBreadcrumbs(machineId, state.cwd) : [];

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
            dispatch({ type: "highlight", index: Math.min(state.highlight + 1, (state.entries?.length ?? 1) - 1) });
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
        {state.entries === null && !state.error && (
          <SkeletonRows />
        )}
        {state.error && <div className="p-3 text-muted-foreground">{state.error}</div>}
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
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={state.cwd ?? "/"}>
          {state.cwd}
        </span>
        <Button
          size="sm"
          disabled={!confirmable}
          onClick={() => state.cwd && onConfirm(linuxCanonical(state.cwd))}
          title={confirmable ? "Use this folder" : "Navigate to a folder first"}
        >
          <CornerDownLeft className="size-3.5" />
          {(() => {
            if (!confirmable) return "Confirm";
            return existingFor?.(linuxCanonical(state.cwd!)) ? "Open project" : "Create project";
          })()}
        </Button>
      </div>
    </div>
  );
}
