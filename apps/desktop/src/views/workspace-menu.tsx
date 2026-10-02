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
  const [failed, setFailed] = useState(false);

  // Fetch on first open (when this section actually mounts — the dropdown
  // content renders lazily).
  useEffect(() => {
    if (!IS_TAURI) return;
    let cancelled = false;
    workspaceList()
      .then((v) => !cancelled && setList(v))
      .catch(() => !cancelled && setFailed(true));
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

  return (
    <>
      {failed || rows.length === 0 ? null : (
        <>
          <DropdownMenuSeparator />
          <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
            Workspaces
          </div>
          {rows.map((w) => {
            const label = w.name || shortOrigin(w.base_url);
            const isActive = w.base_url === active;
            return (
              <DropdownMenuItem
                key={w.base_url}
                disabled={!w.has_token || isActive}
                onClick={() => void switchTo(w.base_url)}
                title={
                  w.has_token
                    ? w.base_url
                    : "Sign in again to use this workspace"
                }
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
                <span className="min-w-0 flex-1 truncate">
                  {label}
                  {w.email ? (
                    <span className="text-muted-foreground"> · {w.email}</span>
                  ) : null}
                </span>
                {isActive ? (
                  <span className="text-xs text-muted-foreground">current</span>
                ) : w.has_token ? (
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
        </>
      )}
      {onAddWorkspace && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={onAddWorkspace}>
            <Plus className="size-4" />
            Add workspace
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}
