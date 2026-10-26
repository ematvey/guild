//! The server switcher (desktop only): the daemon's signed-in servers in a
//! dropdown anchored at the sidebar top. Switching re-points the engine's
//! active session, the webview re-mirrors session.info, and the app reloads —
//! the same restore path a fresh launch takes.

import { useEffect, useState } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@guild/ui/components/dropdown-menu";
import { Skeleton, SkeletonRows } from "@guild/ui/components/skeleton";
import { Plus, X } from "lucide-react";
import { DesktopTooltip } from "../components/desktop-tooltip";
import { IS_TAURI } from "../lib/session";
import {
  serverList,
  serverSignOut,
  serverSwitch,
  type ServerList,
} from "../lib/api/servers";

/** The origin's display label: scheme stripped, so two servers of one org
 * stay distinguishable without a wall of protocol. */
function shortOrigin(base: string): string {
  return base.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** The daemon's live sessions plus the active pointer (desktop only; a
 * failure resolves to an empty list, the UI still renders). */
function useServerList(): ServerList | null {
  const [list, setList] = useState<ServerList | null>(
    IS_TAURI ? null : { active: null, workspaces: [] },
  );
  useEffect(() => {
    if (!IS_TAURI) return;
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

/** The switcher rows: the "Servers" header (the "+" rides on it) and one
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
        <span className="text-xs font-medium text-muted-foreground">Servers</span>
        {onAddWorkspace && (
          <button
            onClick={() => onAddWorkspace()}
            title="Add server"
            aria-label="Add server"
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
            title={
              w.has_token
                ? w.base_url
                : `Sign in again to ${w.base_url}`
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
              <span className="flex size-4 shrink-0 items-center justify-center rounded bg-muted text-xs font-semibold text-muted-foreground">
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
    </>
  );
}

/** Rail trigger: the active server's logo as a compact icon button (the
 * rail's first button); the dropdown carries the switcher rows. On the web
 * (single server) it renders nothing. */
export function ServerRailButton({
  onAddWorkspace,
  onReload,
}: {
  onAddWorkspace?: (baseUrl?: string) => void;
  /** Runs after a switch or sign-out (the caller reloads the app). */
  onReload: () => void;
}) {
  const list = useServerList();
  if (!IS_TAURI) return null;
  const activeRow = (list?.workspaces ?? []).find(
    (w) => w.base_url === (list?.active ?? null),
  );
  const label = activeRow
    ? activeRow.name || shortOrigin(activeRow.base_url)
    : "Guild";
  return (
    <DropdownMenu>
      <DesktopTooltip label="Switch server" side="right">
        <DropdownMenuTrigger asChild>
          <button
            className="flex size-9 items-center justify-center rounded-md outline-none transition-colors hover:bg-accent"
            aria-label="Switch server"
          >
            {list === null ? <Skeleton className="size-6 shrink-0" /> : activeRow?.logo_url ? (
              <img
                src={`${activeRow.base_url.replace(/\/$/, "")}${activeRow.logo_url}`}
                alt=""
                className="size-6 shrink-0 rounded object-contain"
              />
            ) : (
              <span className="flex size-6 shrink-0 items-center justify-center rounded bg-muted text-xs font-semibold text-muted-foreground">
                {label.slice(0, 1).toUpperCase()}
              </span>
            )}
          </button>
        </DropdownMenuTrigger>
      </DesktopTooltip>
      <DropdownMenuContent side="bottom" align="start" className="w-60">
        <ServerMenuItems
          list={list}
          onAddWorkspace={onAddWorkspace}
          onReload={onReload}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

