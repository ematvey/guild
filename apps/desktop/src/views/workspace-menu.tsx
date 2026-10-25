//! The workspace switcher (desktop only): the daemon's live sessions in a
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
import { ChevronDown, Plus, X } from "lucide-react";
import { DesktopTooltip } from "../components/desktop-tooltip";
import { IS_TAURI } from "../lib/session";
import {
  workspaceList,
  workspaceSignOut,
  workspaceSwitch,
  type WorkspaceList,
} from "../lib/api/workspaces";

/** The origin's display label: scheme stripped, so two servers of one org
 * stay distinguishable without a wall of protocol. */
function shortOrigin(base: string): string {
  return base.replace(/^https?:\/\//, "").replace(/\/$/, "");
}

/** The daemon's live sessions plus the active pointer (desktop only; a
 * failure resolves to an empty list, the UI still renders). */
function useWorkspaceList(): WorkspaceList | null {
  const [list, setList] = useState<WorkspaceList | null>(
    IS_TAURI ? null : { active: null, workspaces: [] },
  );
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
  return list;
}

/** The switcher rows: the "Workspaces" header (the "+" rides on it) and one
 * row per live session with the active one highlighted. `list` omitted means
 * self-fetch (standalone use, e.g. the settings window's account menu). */
export function WorkspaceMenuItems({
  list,
  onAddWorkspace,
  onReload,
}: {
  list?: WorkspaceList | null;
  /** Absent on the web (single server): the whole section hides. */
  onAddWorkspace?: () => void;
  /** Runs after a switch or sign-out (the caller reloads the app). */
  onReload: () => void;
}) {
  const fetched = useWorkspaceList();
  const effective = list === undefined ? fetched : list;

  const switchTo = async (base: string) => {
    await workspaceSwitch(base);
    onReload();
  };

  const signOutWs = async (base: string) => {
    await workspaceSignOut(base);
    onReload();
  };

  if (effective === null) return <SkeletonRows rows={2} />;

  const rows = effective?.workspaces ?? [];
  const active = effective?.active ?? null;

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

/** Rail trigger: the active workspace's logo as a compact icon button (the
 * rail's first button); the dropdown carries the switcher rows. On the web
 * (single server) it renders nothing. */
export function WorkspaceRailButton({
  onAddWorkspace,
  onReload,
}: {
  onAddWorkspace?: () => void;
  /** Runs after a switch or sign-out (the caller reloads the app). */
  onReload: () => void;
}) {
  const list = useWorkspaceList();
  if (!IS_TAURI) return null;
  const activeRow = (list?.workspaces ?? []).find(
    (w) => w.base_url === (list?.active ?? null),
  );
  const label = activeRow
    ? activeRow.name || shortOrigin(activeRow.base_url)
    : "Guild";
  return (
    <DropdownMenu>
      <DesktopTooltip label="Switch workspace" side="right">
        <DropdownMenuTrigger asChild>
          <button
            className="flex size-9 items-center justify-center rounded-md outline-none transition-colors hover:bg-accent"
            aria-label="Switch workspace"
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
        <WorkspaceMenuItems
          list={list}
          onAddWorkspace={onAddWorkspace}
          onReload={onReload}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Sidebar-top trigger: the active workspace's logo and name; clicking opens
 * the switcher. On the web (single server) it renders nothing. */
export function WorkspaceSwitcher({
  onAddWorkspace,
  onReload,
}: {
  onAddWorkspace?: () => void;
  /** Runs after a switch or sign-out (the caller reloads the app). */
  onReload: () => void;
}) {
  const list = useWorkspaceList();
  if (!IS_TAURI) return null;

  const rows = list?.workspaces ?? [];
  const activeRow = rows.find((w) => w.base_url === (list?.active ?? null));
  const label = activeRow
    ? activeRow.name || shortOrigin(activeRow.base_url)
    : "Guild";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left outline-none transition-colors hover:bg-accent"
          title="Switch workspace"
        >
          {list === null ? <Skeleton className="size-6 shrink-0" /> : activeRow?.logo_url ? (
            <img
              src={`${activeRow.base_url.replace(/\/$/, "")}${activeRow.logo_url}`}
              alt=""
              className="size-5 shrink-0 rounded object-contain"
            />
          ) : activeRow ? (
            <span className="flex size-5 shrink-0 items-center justify-center rounded bg-muted text-xs font-semibold text-muted-foreground">
              {label.slice(0, 1).toUpperCase()}
            </span>
          ) : null}
          {list === null ? <Skeleton className="h-3.5 w-24" /> : <span className="min-w-0 truncate font-semibold">{label}</span>}
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="bottom" align="start" className="w-60">
        <WorkspaceMenuItems
          list={list}
          onAddWorkspace={onAddWorkspace}
          onReload={onReload}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
