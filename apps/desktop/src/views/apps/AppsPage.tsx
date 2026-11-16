// The Apps page: the Apps the member sees on the left — their own and those
// shared with the org — and the open App on the right, running in its frame.
// On a phone the list and the App take turns. Every state is an /apps
// address; the list is socket state (`app_list`).

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  Globe,
  LayoutGrid,
  MessageSquare,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { EmptyState } from "@guild/ui/components/empty-state";
import { SkeletonRows } from "@guild/ui/components/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@guild/ui/components/dropdown-menu";
import type { App } from "@guild/wire/rest";
import { useMemberProfile } from "../../lib/profile-store";
import { CollapseButton } from "../sidebar/chrome";
import { TOP_ROW } from "../../lib/titlebar";
import { Sidebar, useSidebar } from "../sidebar/sidebar";
import { relativeTime } from "../../lib/relative-time";
import { useApps } from "./apps-store";
import { APPS_HOME, type AppsRoute } from "./apps-route";
import {
  clearAppGrants,
  deleteApp,
  getAppDetail,
  type AppDetail,
} from "./apps-api";
import { AppFrame } from "./AppFrame";
import { AccessPanel } from "../access/AccessPanel";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@guild/ui/components/dialog";

type Navigate = (next: AppsRoute, options?: { replace?: boolean }) => void;

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="px-2.5 pb-1 pt-4 text-xs font-medium text-muted-foreground first:pt-1">
      {children}
    </p>
  );
}

function AppRow({
  app,
  selected,
  onClick,
}: {
  app: App;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={selected ? "page" : undefined}
        className={`flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
          selected ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"
        }`}
      >
        <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
          <LayoutGrid className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <span className="truncate text-sm font-medium">{app.name}</span>
            {app.visibility === "org" && (
              <Globe
                aria-label="Shared with the org"
                className="size-3 shrink-0"
              />
            )}
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {app.description !== "" ? app.description : `by ${app.owner_label}`}
          </span>
        </span>
      </button>
    </li>
  );
}

function ListPane({
  apps,
  route,
  navigate,
  me,
  onCollapse,
}: {
  apps: App[] | null;
  route: AppsRoute;
  navigate: Navigate;
  me: string | null;
  /** Desktop only: collapse the sidebar from its own header. */
  onCollapse?: () => void;
}) {
  const mine = (apps ?? []).filter((app) => app.owner_user_id === me);
  const shared = (apps ?? []).filter((app) => app.owner_user_id !== me);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className={`flex items-center justify-between gap-2 px-4 ${TOP_ROW}`}>
        <h1 className="text-lg font-semibold">Apps</h1>
        <CollapseButton onCollapse={onCollapse} />
      </div>
      <nav
        aria-label="Apps"
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-6"
        data-scrollable
      >
        {apps === null ? (
          <div className="space-y-2 px-2 pt-3">
            <SkeletonRows rows={4} />
          </div>
        ) : apps.length === 0 ? (
          <p className="px-2.5 pt-1 text-sm text-muted-foreground">
            No apps yet.
          </p>
        ) : (
          (
            [
              ["Yours", mine],
              ["Shared with the org", shared],
            ] as const
          )
            .filter(([, list]) => list.length > 0)
            .map(([label, list]) => (
              <div key={label}>
                <GroupLabel>{label}</GroupLabel>
                <ul className="space-y-0.5">
                  {list.map((app) => (
                    <AppRow
                      key={app.id}
                      app={app}
                      selected={route.appId === app.id}
                      onClick={() => navigate({ appId: app.id })}
                    />
                  ))}
                </ul>
              </div>
            ))
        )}
      </nav>
    </div>
  );
}

function NoApps() {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <EmptyState
        icon={LayoutGrid}
        title="Apps your agents build"
        hint={
          <>
            Ask an agent for a page that shows live data, for example “build an
            app with open deals by stage from HubSpot”. It publishes the page
            here; you can share it with the org. Each person who opens it sees
            data through their own integration access.
          </>
        }
      />
    </div>
  );
}

function AppHeader({
  app,
  detail,
  isOwner,
  canDelete,
  isMobile,
  onBack,
  onOpenChat,
  onDeleted,
  onGrantsCleared,
  onEditAccess,
}: {
  app: App;
  detail: AppDetail | null;
  isOwner: boolean;
  canDelete: boolean;
  isMobile: boolean;
  onBack: () => void;
  onOpenChat: ((chatId: string) => void) | null;
  onDeleted: () => void;
  onGrantsCleared: () => void;
  onEditAccess: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const unavailable = (detail?.functions ?? []).filter((fn) => !fn.available);
  const asks = (detail?.functions ?? []).some(
    (fn) => fn.available && fn.confirm,
  );
  return (
    <header className="border-b border-border px-4 py-3">
      <div className="flex items-center gap-2">
        {isMobile && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="All apps"
            onClick={onBack}
          >
            <ArrowLeft />
          </Button>
        )}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-base font-semibold">{app.name}</h2>
          <p className="truncate text-xs text-muted-foreground">
            {app.visibility === "org" ? "Shared with the org" : "Private"} · by{" "}
            {app.owner_label}
            {app.agent_name !== null ? ` with ${app.agent_name}` : ""} · v
            {app.version} · updated {relativeTime(app.updated_at)}
          </p>
        </div>
        {(isOwner ||
          app.can_edit ||
          canDelete ||
          asks ||
          (onOpenChat !== null && app.chat_id !== null)) && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={busy}>
                Manage
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {onOpenChat !== null && app.chat_id !== null && (
                <DropdownMenuItem onSelect={() => onOpenChat(app.chat_id!)}>
                  <MessageSquare className="size-4" /> Open the chat that built
                  it
                </DropdownMenuItem>
              )}
              {asks && (
                <DropdownMenuItem
                  onSelect={() =>
                    void act(async () => {
                      await clearAppGrants(app.id);
                      onGrantsCleared();
                    })
                  }
                >
                  <ShieldCheck className="size-4" /> Ask again before data
                  access
                </DropdownMenuItem>
              )}
              {(isOwner || app.can_edit) && (
                <DropdownMenuItem onSelect={() => onEditAccess()}>
                  <Users className="size-4" /> Sharing
                </DropdownMenuItem>
              )}
              {canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    className="text-destructive focus:text-destructive"
                    onSelect={() => {
                      if (
                        !window.confirm(
                          `Delete ${app.name}? Everyone it is shared with loses it.`,
                        )
                      )
                        return;
                      void act(async () => {
                        await deleteApp(app.id);
                        onDeleted();
                      });
                    }}
                  >
                    <Trash2 className="size-4" /> Delete
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      {unavailable.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground">
          Some data is not available to you:{" "}
          {unavailable
            .map((fn) => `${fn.name} (${fn.reason ?? "no access"})`)
            .join(", ")}
          .
        </p>
      )}
    </header>
  );
}

function OpenApp({
  app,
  me,
  isMobile,
  navigate,
  onOpenChat,
}: {
  app: App;
  me: { id: string; role: string } | null;
  isMobile: boolean;
  navigate: Navigate;
  onOpenChat: ((chatId: string) => void) | null;
}) {
  const [detail, setDetail] = useState<AppDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped when the viewer clears their grants: the detail re-reads and the
  // frame starts over, so its next calls ask again.
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    let dead = false;
    setError(null);
    setDetail(null);
    getAppDetail(app.id)
      .then((next) => {
        if (!dead) setDetail(next);
      })
      .catch((e: unknown) => {
        if (!dead) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      dead = true;
    };
  }, [app.id, app.version, epoch]);
  const isOwner = me !== null && app.owner_user_id === me.id;
  const canDelete = isOwner || me?.role === "admin";
  const [accessOpen, setAccessOpen] = useState(false);
  const current = detail !== null && detail.app.id === app.id ? detail : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <AppHeader
        app={app}
        detail={current}
        isOwner={isOwner}
        canDelete={canDelete}
        isMobile={isMobile}
        onBack={() => navigate(APPS_HOME)}
        onOpenChat={onOpenChat}
        onDeleted={() => navigate(APPS_HOME, { replace: true })}
        onGrantsCleared={() => setEpoch((n) => n + 1)}
        onEditAccess={() => setAccessOpen(true)}
      />
      <Dialog open={accessOpen} onOpenChange={setAccessOpen}>
        <DialogContent
          className="max-h-[85vh] max-w-2xl overflow-y-auto"
          aria-describedby={undefined}
        >
          <DialogHeader>
            <DialogTitle>Sharing</DialogTitle>
          </DialogHeader>
          <AccessPanel kind="app" id={app.id} />
        </DialogContent>
      </Dialog>
      <div className="min-h-0 flex-1">
        {error !== null ? (
          <p role="alert" className="p-6 text-sm text-destructive">
            {error}
          </p>
        ) : current === null ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            Opening…
          </div>
        ) : (
          <AppFrame
            key={epoch}
            app={{ id: app.id, name: app.name, version: current.app.version }}
            functions={current.functions}
          />
        )}
      </div>
    </div>
  );
}

export function AppsPage({
  route,
  navigate,
  isMobile,
  onOpenChat,
}: {
  route: AppsRoute;
  navigate: Navigate;
  isMobile: boolean;
  onOpenChat: ((chatId: string) => void) | null;
}) {
  const apps = useApps();
  const sidebar = useSidebar();
  const profile = useMemberProfile();
  const me = profile === null ? null : { id: profile.id, role: profile.role };
  const open =
    route.appId === null
      ? null
      : ((apps ?? []).find((app) => app.id === route.appId) ?? null);
  const missing = route.appId !== null && apps !== null && open === null;

  const page =
    open !== null ? (
      <OpenApp
        key={open.id}
        app={open}
        me={me}
        isMobile={isMobile}
        navigate={navigate}
        onOpenChat={onOpenChat}
      />
    ) : missing ? (
      <div className="flex h-full items-center justify-center p-6">
        <EmptyState
          icon={LayoutGrid}
          title="This app is gone"
          hint="It was deleted, or its owner stopped sharing it."
          action={
            <Button
              variant="outline"
              onClick={() => navigate(APPS_HOME, { replace: true })}
            >
              All apps
            </Button>
          }
        />
      </div>
    ) : (
      <NoApps />
    );

  if (isMobile) {
    return route.appId === null ? (
      <ListPane
        apps={apps}
        route={route}
        navigate={navigate}
        me={me?.id ?? null}
      />
    ) : (
      page
    );
  }
  return (
    <div className="flex h-full min-h-0">
      <Sidebar collapsed={sidebar.collapsed}>
        <ListPane
          apps={apps}
          route={route}
          navigate={navigate}
          me={me?.id ?? null}
          onCollapse={() => sidebar.setCollapsed(true)}
        />
      </Sidebar>
      <section className="min-w-0 flex-1">{page}</section>
    </div>
  );
}
