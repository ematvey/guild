//! The server switcher (desktop only): the daemon's signed-in servers in the
//! account menu. Switching re-points the engine's active session, the webview
//! re-mirrors session.info, and the app reloads — the same restore path a
//! fresh launch takes.

import { useEffect, useState } from "react";
import { DropdownMenuItem } from "@guild/ui/components/dropdown-menu";
import { SkeletonRows } from "@guild/ui/components/skeleton";
import { Plus, X } from "lucide-react";
import { HAS_ENGINE } from "../lib/session";
import { serverList, serverSignOut, serverSwitch, type ServerList } from "../lib/api/servers";

/** The origin's display label: scheme stripped, so two servers of one org
 * stay distinguishable without a wall of protocol. */
function shortOrigin(base: string): string {
  return base.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** The daemon's live sessions plus the active pointer (desktop only; a
 * failure resolves to an empty list, the UI still renders). */
function useServerList(): ServerList | null {
  const [list, setList] = useState<ServerList | null>(HAS_ENGINE ? null : { active: null, workspaces: [] });
  useEffect(() => {
    if (!HAS_ENGINE) return;
    let cancelled = false;
    serverList()
      .then((v) => !cancelled && setList(v))
      .catch(() => !cancelled && setList({ active: null, workspaces: [] }));
    return () => {
      cancelled = true;
    };
  }, []);
  return list;
}

/** The switcher rows: the "Workspaces" header (the "+" rides on it) and one
 * row per signed-in server with the active one highlighted. `list` omitted
 * means self-fetch (standalone use, e.g. the settings window's account menu). */
export function ServerMenuItems({
  list,
  onAddWorkspace,
  onReload,
}: {
  list?: ServerList | null;
  /** Absent on the web (single server): the whole section hides. The
   * base_url argument is set when a dead-token row asks to sign in again. */
  onAddWorkspace?: (baseUrl?: string) => void;
  /** Runs after a switch or sign-out (the caller reloads the app). */
  onReload: () => void;
}) {
  const fetched = useServerList();
  const effective = list === undefined ? fetched : list;

  const switchTo = async (base: string) => {
    await serverSwitch(base);
    onReload();
  };

  const signOutWs = async (base: string) => {
    await serverSignOut(base);
    onReload();
  };

  if (effective === null) return <SkeletonRows rows={2} />;

  const rows = effective?.workspaces ?? [];
  const active = effective?.active ?? null;

  return (
    <>
      <div className="flex items-center justify-between px-2 pb-1 pt-1.5">
        <span className="text-base font-medium text-muted-foreground">Workspaces</span>
        {onAddWorkspace && (
          <button
            onClick={() => onAddWorkspace()}
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
            disabled={!w.has_token && !onAddWorkspace}
            onClick={() => {
              if (!w.has_token) {
                // A dead token cannot switch — re-auth this server instead.
                onAddWorkspace?.(w.base_url);
                return;
              }
              if (isActive) return; // switching to the current one is a no-op
              void switchTo(w.base_url);
            }}
            title={w.has_token ? w.base_url : `Sign in again to ${w.base_url}`}
            className={isActive ? "bg-accent/40 text-base" : "text-base"}
          >
            {w.logo_url ? (
              <img
                src={`${w.base_url.replace(/\/$/, "")}${w.logo_url}`}
                alt=""
                className="size-4 shrink-0 rounded object-contain"
              />
            ) : (
              <span className="flex size-4 shrink-0 items-center justify-center rounded bg-muted text-base font-semibold text-muted-foreground">
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
              <span className="text-base text-destructive">sign in again</span>
            )}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}
