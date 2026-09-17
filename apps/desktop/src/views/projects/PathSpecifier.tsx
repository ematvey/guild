// In-app folder browser for a WSL distro (the create-project dialog's path
// specifier, spec §5): unfiltered listing over \\wsl.localhost\<distro>\,
// `~`-expanding path field, Enter jumps into a typed path or descends the
// highlighted row, breadcrumb up-navigation. The browse state machine is
// pure (./projects.ts); this component runs the listing effects.

import { useEffect, useReducer, useRef, useState } from "react";
import { ChevronRight, CornerDownLeft, Folder, FolderOpen } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { Spinner } from "@guild/ui/components/spinner";
import { listDir, wslHome } from "../../transport";
import {
  breadcrumbs,
  canonicalDir,
  displayPath,
  expandError,
  expandPath,
  pickerReducer,
  pickerFor,
  wslHomeUnc,
  wslRoot,
} from "./projects";

export function PathSpecifier({
  distro,
  onConfirm,
}: {
  distro: string;
  /** Called with the confirmed folder (UNC path, canonical). */
  onConfirm: (folder: string) => void;
}) {
  const [state, dispatch] = useReducer(
    pickerReducer,
    undefined,
    () => pickerFor(distro, wslRoot(distro)),
  );
  const [homeUnc, setHomeUnc] = useState<string | null>(null);
  // The path field holds the DISPLAY form (~-shortened); empty means the
  // user has not typed, so Enter descends the highlighted row.
  const [typed, setTyped] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // ~ expansion needs the distro home (LINUX $HOME → UNC), fetched once.
  useEffect(() => {
    let dead = false;
    void wslHome(distro)
      .then((home) => {
        if (!dead && home) setHomeUnc(wslHomeUnc(distro, home));
      })
      .catch(() => {});
    return () => {
      dead = true;
    };
  }, [distro]);

  // Listing effect: every cwd change lists through the app process. Only a
  // result for the CURRENT cwd lands (the reducer drops stale ones).
  useEffect(() => {
    if (!state.cwd) return;
    const path = state.cwd;
    dispatch({ type: "loading", path });
    let dead = false;
    void listDir(path)
      .then((entries) => {
        if (!dead) dispatch({ type: "loaded", path, entries });
      })
      .catch((e) => {
        if (!dead) dispatch({ type: "failed", path, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      dead = true;
    };
  }, [state.cwd]);

  // The field mirrors the view's path until the user types over it.
  useEffect(() => {
    setTyped(state.cwd ? displayPath(state.cwd, homeUnc) : "");
  }, [state.cwd, homeUnc]);

  const confirmable = state.entries !== null && state.cwd !== null;
  const dirty = state.cwd !== null && typed !== displayPath(state.cwd, homeUnc);

  const commitInput = () => {
    if (!dirty) {
      dispatch({ type: "descend" });
      return;
    }
    // A bare `~` with an unavailable home is an error, not a descend.
    const err = expandError(typed, homeUnc);
    if (err) {
      dispatch({ type: "error", message: err });
      return;
    }
    const path = expandPath(typed, homeUnc);
    if (path) dispatch({ type: "go", path });
    else dispatch({ type: "descend" });
  };

  const crumbs = state.cwd ? breadcrumbs(state.cwd) : [];

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
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
        placeholder={homeUnc ? "~" : `\\\\wsl.localhost\\${distro}\\`}
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
      <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border">
        {state.entries === null && !state.error && (
          <div className="flex items-center gap-2 p-3 text-muted-foreground">
            <Spinner className="size-3.5" /> listing…
          </div>
        )}
        {state.error && (
          <div className="p-3 text-muted-foreground">
            {state.error}
            {state.error.includes("wsl") || state.error.toLowerCase().includes("network")
              ? " — the distro may be stopped; retrying usually starts it."
              : ""}
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
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground" title={state.cwd ?? ""}>
          {state.cwd}
        </span>
        <Button
          size="sm"
          disabled={!confirmable}
          onClick={() => state.cwd && onConfirm(canonicalDir(state.cwd))}
          title={confirmable ? "Use this folder" : "Navigate to a folder first"}
        >
          <CornerDownLeft className="size-3.5" />
          Confirm
        </Button>
      </div>
    </div>
  );
}
