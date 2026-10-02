//! The workspace switcher (desktop only): the daemon's live sessions in the
//! account dropdown. Switching re-points the engine's active session, the
//! webview re-mirrors session.info, and the app reloads — the same restore
//! path a fresh launch takes.

import { useEffect, useState } from "react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@guild/ui/components/dropdown-menu";
import { Plus, X } from "lucide-react";
import {
  IS_TAURI,
  workspaceList,
  workspaceSignOut,
  workspaceSwitch,
  type WorkspaceList,
} from "../transport";

/** The origin's display label: scheme stripped, so two servers of one org
 * stay distinguishable without a wall of protocol. */
function shortOrigin(base: string): string {
  return base.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

export function WorkspaceMenuItems({
  onAddWorkspace,
  onReload,
}: {
  /** Absent on the web (single server): the whole section hides. */
  onAddWorkspace?: () => void;
  /** Runs after a switch or sign-out (the caller reloads the app). */
  onReload: () => void;
}) {
  const [list, setList] = useState<WorkspaceList | null>(null);

  // Fetch on first open (when this section actually mounts — the dropdown
  // content renders lazily). A failure just means no rows: the header with
  // the "+" stays.
  useEffect(() => {
    if (!IS_TAURI) return;
    let cancelled = false;
    workspaceList()
      .then((v) => !cancelled && setList(v))
      .catch(() => !cancelled && setList({ active: null, workspaces: [] }));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!IS_TAURI) return null;

  const switchTo = async (base: string) => {
    await workspaceSwitch(base);
    onReload();
  };

  const signOutWs = async (base: string) => {
    await workspaceSignOut(base);
    onReload();
  };

  const rows = list?.workspaces ?? [];
  const active = list?.active ?? null;

  // The section header is always present on desktop (the "+" rides on it);
  // rows follow when the list resolved.
  return (
    <>
      <div className="flex items-center justify-between px-2 pb-1 pt-1.5">
        <span className="text-xs font-medium text-muted-foreground">Workspaces</span>
        {onAddWorkspace && (
          <button
            onClick={onAddWorkspace}
            title="Add workspace"
            aria-label="Add workspace"
            className="rounded p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground"
          >
            <Plus className="size-3.5" />
          </button>
        )}
      </div>
      {rows.map((w) => {
            const label = w.name || shortOrigin(w.base_url);
            const isActive = w.base_url === active;
            return (
              <DropdownMenuItem
                key={w.base_url}
                disabled={!w.has_token}
                onClick={() => {
                  if (isActive) return; // switching to the current one is a no-op
                  void switchTo(w.base_url);
                }}
                title={
                  w.has_token
                    ? w.base_url
                    : "Sign in again to use this workspace"
                }
                className={isActive ? "bg-accent/40" : undefined}
              >
                {w.logo_url ? (
                  <img
                    src={`${w.base_url.replace(/\/$/, "")}${w.logo_url}`}
                    alt=""
                    className="size-4 shrink-0 rounded object-contain"
                  />
                ) : (
                  <span className="flex size-4 shrink-0 items-center justify-center rounded bg-muted text-[9px] font-semibold text-muted-foreground">
                    {label.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {w.has_token ? (
                  <span
                    role="button"
                    aria-label={`Sign out ${label}`}
                    title={`Sign out ${label}`}
                    className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-destructive"
                    onClick={(e) => {
                      e.stopPropagation();
                      void signOutWs(w.base_url);
                    }}
                  >
                    <X className="size-3.5" />
                  </span>
                ) : (
                  <span className="text-xs text-destructive">sign in again</span>
                )}
              </DropdownMenuItem>
            );
          })}
      <DropdownMenuSeparator />
    </>
  );
}
