// The integrations page (admin): a list pane on the left — Installed or
// Catalog, searchable — and the wide page of whatever it selects on the
// right: an installed integration's tabs, a catalog landing page, or the
// connect and source pages. Every state is an /integrations address.

import { useMemo, useState } from "react";
import { ArrowLeft, BookOpen, Plus, Search, Server, Upload } from "lucide-react";
import { Input } from "@guild/ui/components/input";
import { SkeletonRows } from "@guild/ui/components/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@guild/ui/components/dropdown-menu";
import { useCachedGet } from "../settings/use-cached-api";
import { listPluginCatalogs, pluginCatalogsPath } from "../../lib/api/settings";
import {
  INTEGRATIONS_PATH,
  USAGE_SUMMARY_PATH,
  type CatalogRow,
  type ShopItem,
  type UsageSummaryRow,
} from "./integrations-api";
import {
  INTEGRATIONS_CATALOG,
  INTEGRATIONS_HOME,
  type IntegrationsRoute,
  type InstalledTab,
} from "./integrations-route";
import {
  availableUpdates,
  buildCatalog,
  compactCount,
  findCatalogEntry,
  installedStatus,
  matchesQuery,
  needsAttention,
  statusLine,
  statusWord,
  type AvailableUpdate,
  type CatalogGroup,
} from "./model";
import { Logo } from "./brand";
import { StatusDot } from "./status-dot";
import { InstalledDetail } from "./installed";
import { CatalogLandingPage } from "./landing";
import { AddOrgMcp } from "./connect-mcp";
import { CatalogSources, InstallBundle } from "./sources";

type Navigate = (next: IntegrationsRoute, options?: { replace?: boolean }) => void;

function useIntegrationsData() {
  const shop = useCachedGet<{ items: ShopItem[] }>(INTEGRATIONS_PATH);
  const usage = useCachedGet<{ items: UsageSummaryRow[] }>(USAGE_SUMMARY_PATH);
  const cachedCatalogs = useCachedGet<{ catalogs: CatalogRow[] }>(pluginCatalogsPath);
  const [freshCatalogs, setFreshCatalogs] = useState<CatalogRow[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const refreshCatalogs = async () => {
    setRefreshing(true);
    try {
      setFreshCatalogs((await listPluginCatalogs<{ catalogs: CatalogRow[] }>(true)).catalogs);
      setCatalogError(null);
    } catch (e) {
      setCatalogError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };
  const reload = () => {
    shop.reload();
    usage.reload();
    setFreshCatalogs(null);
    cachedCatalogs.reload();
  };
  return {
    items: shop.data?.items ?? null,
    shopError: shop.error,
    usage: new Map((usage.data?.items ?? []).map((u) => [u.slug, u])),
    catalogs: freshCatalogs ?? cachedCatalogs.data?.catalogs ?? null,
    catalogError: catalogError ?? cachedCatalogs.error,
    refreshing,
    refreshCatalogs,
    reload,
  };
}

function ListRow({
  selected,
  onClick,
  logo,
  title,
  line,
  dot,
}: {
  selected: boolean;
  onClick: () => void;
  logo: string;
  title: string;
  line: React.ReactNode;
  dot?: React.ReactNode;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-current={selected ? "page" : undefined}
        className={`flex w-full items-center gap-3 rounded-md px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
          selected ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60"
        }`}
      >
        <Logo svg={logo} title={title} size="size-8" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{title}</span>
          <span className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            {dot}
            <span className="truncate">{line}</span>
          </span>
        </span>
      </button>
    </li>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return <p className="px-2.5 pb-1 pt-4 text-xs font-medium text-muted-foreground first:pt-1">{children}</p>;
}

function ListPane({
  route,
  navigate,
  installed,
  usage,
  updates,
  catalog,
  loading,
}: {
  route: IntegrationsRoute;
  navigate: Navigate;
  installed: ShopItem[];
  usage: Map<string, UsageSummaryRow>;
  updates: Map<string, AvailableUpdate>;
  catalog: CatalogGroup[];
  loading: boolean;
}) {
  const view = route.view === "catalog" ? "catalog" : "installed";
  const q = route.view === "installed" || route.view === "catalog" ? route.q : "";
  const setQuery = (next: string) => {
    if (route.view === "installed" || route.view === "catalog") navigate({ ...route, q: next }, { replace: true });
    else navigate(view === "catalog" ? { ...INTEGRATIONS_CATALOG, q: next } : { ...INTEGRATIONS_HOME, q: next });
  };
  const shownInstalled = installed.filter((i) => matchesQuery(q, i.title, i.name, i.summary));
  const attention = shownInstalled.filter((i) => needsAttention(installedStatus(i, usage.get(i.name))));
  const on = shownInstalled.filter((i) => i.enabled && !attention.includes(i));
  const off = shownInstalled.filter((i) => !i.enabled && !attention.includes(i));
  const shownCatalog = catalog
    .map((g) => ({ ...g, entries: g.entries.filter((e) => matchesQuery(q, e.title, e.slug, e.summary, e.publisher)) }))
    .filter((g) => g.entries.length > 0);
  const catalogCount = catalog.reduce((n, g) => n + g.entries.length, 0);

  const installedGroups: [string, ShopItem[]][] = [
    ["Needs attention", attention],
    ["On", on],
    ["Off", off],
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pb-3 pt-5">
        <h1 className="text-lg font-semibold">Integrations</h1>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label="Add an integration"
              className="flex size-9 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Plus className="size-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-60">
            <DropdownMenuItem onSelect={() => navigate(INTEGRATIONS_CATALOG)}>
              <BookOpen className="size-4" /> Browse the catalog
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate({ view: "connect", kind: "mcp" })}>
              <Server className="size-4" /> Connect an MCP server
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate({ view: "connect", kind: "file" })}>
              <Upload className="size-4" /> Install a plugin bundle
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate({ view: "sources" })}>
              <BookOpen className="size-4" /> Catalog sources
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="px-4">
        <div role="tablist" aria-label="List" className="grid grid-cols-2 rounded-lg bg-sidebar-accent p-0.5">
          {(
            [
              ["installed", "Installed", installed.length],
              ["catalog", "Catalog", catalogCount],
            ] as const
          ).map(([id, label, count]) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={view === id}
              onClick={() => navigate(id === "catalog" ? { ...INTEGRATIONS_CATALOG, q } : { ...INTEGRATIONS_HOME, q })}
              className={`flex items-center justify-center gap-1.5 rounded-md py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${
                view === id ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
              <span className="text-xs tabular-nums text-muted-foreground">{count}</span>
            </button>
          ))}
        </div>
        <div className="relative mt-3">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label={view === "catalog" ? "Search the catalog" : "Search installed integrations"}
            placeholder={view === "catalog" ? "Search the catalog" : "Search installed"}
            className="h-8 bg-background pl-8"
            value={q}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <nav
        aria-label={view === "catalog" ? "Catalog" : "Installed integrations"}
        className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-6"
        data-scrollable
      >
        {loading ? (
          <div className="space-y-2 px-2 pt-3">
            <SkeletonRows rows={6} />
          </div>
        ) : view === "installed" ? (
          shownInstalled.length === 0 ? (
            <p className="px-2.5 pt-4 text-sm text-muted-foreground">
              {q !== "" ? "Nothing installed matches." : "Nothing installed yet. Pick one from the catalog."}
            </p>
          ) : (
            installedGroups
              .filter(([, list]) => list.length > 0)
              .map(([label, list]) => (
                <div key={label}>
                  <GroupLabel>{label}</GroupLabel>
                  <ul className="space-y-0.5">
                    {list.map((i) => {
                      const status = installedStatus(i, usage.get(i.name));
                      const update = updates.get(i.name);
                      return (
                        <ListRow
                          key={i.name}
                          selected={route.view === "installed" && route.slug === i.name}
                          onClick={() =>
                            navigate({
                              view: "installed",
                              slug: i.name,
                              tab: route.view === "installed" && route.slug !== null ? route.tab : "overview",
                              q,
                            })
                          }
                          logo={i.logo}
                          title={i.title}
                          dot={<StatusDot status={status} />}
                          line={update ? `${statusLine(status)} · update ${update.latest}` : statusLine(status)}
                        />
                      );
                    })}
                  </ul>
                </div>
              ))
          )
        ) : shownCatalog.length === 0 ? (
          <p className="px-2.5 pt-4 text-sm text-muted-foreground">
            {q !== ""
              ? "Nothing in the catalog matches."
              : "Everything available is installed. Add a catalog source for more."}
          </p>
        ) : (
          shownCatalog.map((g) => (
            <div key={g.id}>
              <GroupLabel>{g.label}</GroupLabel>
              <ul className="space-y-0.5">
                {g.entries.map((e) => (
                  <ListRow
                    key={`${g.id}/${e.slug}`}
                    selected={route.view === "catalog" && route.slug === e.slug}
                    onClick={() =>
                      navigate({ view: "catalog", slug: e.slug, from: e.kind === "remote" ? e.catalogId : null, q })
                    }
                    logo={e.logo}
                    title={e.title}
                    line={e.summary || e.publisher}
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

/** The right pane with nothing picked on the Installed list: what needs the
 *  admin, then every installed integration in one table. */
function InstalledHome({
  installed,
  usage,
  updates,
  navigate,
}: {
  installed: ShopItem[];
  usage: Map<string, UsageSummaryRow>;
  updates: Map<string, AvailableUpdate>;
  navigate: Navigate;
}) {
  const onCount = installed.filter((i) => i.enabled).length;
  const open = (slug: string, tab: InstalledTab = "overview") => navigate({ view: "installed", slug, tab, q: "" });
  if (installed.length === 0) {
    return (
      <div className="max-w-prose pt-10">
        <h2 className="text-2xl font-semibold">Give agents your tools</h2>
        <p className="mt-3 text-base leading-relaxed text-muted-foreground">
          Integrations let agents search, read and act in the services your organization uses. Nothing is installed yet.
        </p>
        <button
          type="button"
          onClick={() => navigate(INTEGRATIONS_CATALOG)}
          className="mt-6 inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          Browse the catalog
        </button>
      </div>
    );
  }
  return (
    <div>
      <h2 className="text-2xl font-semibold">Installed</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {installed.length} installed, {onCount} on. Calls are for the last 7 days.
      </p>
      <div className="mt-8 overflow-x-auto">
        <table className="w-full min-w-[42rem] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="py-2 pr-4 font-medium">Integration</th>
              <th className="py-2 pr-4 font-medium">Status</th>
              <th className="py-2 pr-4 text-right font-medium">Calls</th>
              <th className="py-2 pr-4 text-right font-medium">Failed</th>
              <th className="py-2 font-medium">Version</th>
            </tr>
          </thead>
          <tbody>
            {installed.map((i) => {
              const u = usage.get(i.name);
              const status = installedStatus(i, u);
              const update = updates.get(i.name);
              return (
                <tr key={i.name} className="border-b border-border/60 hover:bg-accent/40">
                  <td className="py-2.5 pr-4">
                    <button type="button" className="flex items-center gap-3 text-left" onClick={() => open(i.name)}>
                      <Logo svg={i.logo} title={i.title} size="size-6" />
                      <span className="font-medium">{i.title}</span>
                    </button>
                  </td>
                  <td className="py-2.5 pr-4">
                    <button
                      type="button"
                      className="flex items-center gap-2 text-left text-muted-foreground hover:text-foreground"
                      onClick={() =>
                        open(
                          i.name,
                          status.kind === "needs_setup"
                            ? "configuration"
                            : status.kind === "failing"
                              ? "usage"
                              : "overview",
                        )
                      }
                    >
                      <StatusDot status={status} /> {statusWord(status)}
                    </button>
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums text-muted-foreground">
                    {u ? compactCount(u.calls) : "—"}
                  </td>
                  <td className="py-2.5 pr-4 text-right tabular-nums text-muted-foreground">
                    {u && u.errors > 0 ? u.errors : "—"}
                  </td>
                  <td className="py-2.5 text-muted-foreground">
                    {i.version || "—"}
                    {update && (
                      <button
                        type="button"
                        className="ml-2 text-xs text-foreground underline-offset-2 hover:underline"
                        onClick={() => open(i.name, "about")}
                      >
                        {update.latest} available
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** The right pane with nothing picked on the Catalog list. */
function CatalogHome({
  catalog,
  catalogs,
  navigate,
}: {
  catalog: CatalogGroup[];
  catalogs: CatalogRow[] | null;
  navigate: Navigate;
}) {
  const failing = (catalogs ?? []).filter((c) => c.error !== null);
  return (
    <div className="max-w-4xl">
      <h2 className="text-2xl font-semibold">Catalog</h2>
      <p className="mt-2 max-w-prose text-base leading-relaxed text-muted-foreground">
        Everything your organization can add. Pick one on the left to read what it does and what it needs before you
        install it.
      </p>
      {failing.length > 0 && (
        <div role="alert" className="mt-6 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
          {failing.map((c) => (
            <p key={c.id}>
              <span className="font-medium">{c.name}</span> could not be read: {c.error}
            </p>
          ))}
        </div>
      )}
      <ul className="mt-8 divide-y divide-border border-y border-border">
        {catalog.map((g) => (
          <li key={g.id} className="flex items-baseline justify-between gap-4 py-3 text-sm">
            <span>{g.label}</span>
            <span className="tabular-nums text-muted-foreground">
              {g.entries.length} {g.entries.length === 1 ? "integration" : "integrations"}
            </span>
          </li>
        ))}
      </ul>
      <h3 className="mt-12 text-lg font-semibold">Not listed?</h3>
      <div className="mt-4 grid gap-6 sm:grid-cols-3">
        {(
          [
            [
              Server,
              "Connect an MCP server",
              "Any remote MCP server, for the whole organization.",
              { view: "connect", kind: "mcp" },
            ],
            [
              Upload,
              "Install a plugin bundle",
              "A .guildplugin file or a link to one.",
              { view: "connect", kind: "file" },
            ],
            [BookOpen, "Add a catalog source", "A plugin index on the web, GitHub or GitLab.", { view: "sources" }],
          ] as const
        ).map(([Icon, title, text, to]) => (
          <button
            key={title}
            type="button"
            onClick={() => navigate(to)}
            className="group text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon className="block size-5 text-muted-foreground group-hover:text-foreground" />
            <p className="mt-2 text-sm font-medium group-hover:underline">{title}</p>
            <p className="mt-1 text-xs text-muted-foreground">{text}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

export function IntegrationsPage({
  route,
  navigate,
  openAgent,
  isMobile,
}: {
  route: IntegrationsRoute;
  navigate: Navigate;
  /** Leaves the page for one agent's settings. */
  openAgent: (agentId: string) => void;
  isMobile: boolean;
}) {
  const data = useIntegrationsData();
  const items = data.items;
  const installed = useMemo(
    () => (items ?? []).filter((i) => i.configured).sort((a, b) => a.title.localeCompare(b.title)),
    [items],
  );
  const catalog = useMemo(() => buildCatalog(items ?? [], data.catalogs ?? []), [items, data.catalogs]);
  const updates = useMemo(() => availableUpdates(data.catalogs ?? []), [data.catalogs]);
  const loading = items === null;

  const selected =
    (route.view === "installed" && route.slug !== null) ||
    (route.view === "catalog" && route.slug !== null) ||
    route.view === "connect" ||
    route.view === "sources";

  const afterInstall = (slug: string) => {
    data.reload();
    navigate({ view: "installed", slug, tab: "configuration", q: "" });
  };

  let page: React.ReactNode;
  if (data.shopError && items === null) {
    page = (
      <p role="alert" className="text-sm text-destructive">
        {data.shopError}
      </p>
    );
  } else if (route.view === "connect") {
    page = route.kind === "mcp" ? <AddOrgMcp onCreated={afterInstall} /> : <InstallBundle onInstalled={afterInstall} />;
  } else if (route.view === "sources") {
    page = (
      <CatalogSources
        catalogs={data.catalogs}
        error={data.catalogError}
        refreshing={data.refreshing}
        onRefresh={data.refreshCatalogs}
      />
    );
  } else if (loading) {
    page = (
      <div className="max-w-3xl space-y-4">
        <SkeletonRows rows={8} />
      </div>
    );
  } else if (route.view === "installed") {
    if (route.slug === null) {
      page = <InstalledHome installed={installed} usage={data.usage} updates={updates} navigate={navigate} />;
    } else {
      const item = installed.find((i) => i.name === route.slug) ?? null;
      page =
        item === null ? (
          <NotFound
            text="This integration is not installed."
            action="Find it in the catalog"
            onAction={() => navigate({ view: "catalog", slug: route.slug, from: null, q: "" })}
          />
        ) : (
          <InstalledDetail
            key={item.name}
            item={item}
            tab={route.tab}
            usage={data.usage.get(item.name)}
            update={updates.get(item.name)}
            onTab={(tab) => navigate({ ...route, tab })}
            onOpenAgent={openAgent}
            onChanged={data.reload}
            onRemoved={() => {
              data.reload();
              navigate({ ...INTEGRATIONS_HOME, q: route.q });
            }}
          />
        );
    }
  } else if (route.slug === null) {
    page = <CatalogHome catalog={catalog} catalogs={data.catalogs} navigate={navigate} />;
  } else {
    const entry = findCatalogEntry(catalog, route.slug, route.from);
    if (entry !== null) {
      page = <CatalogLandingPage key={`${route.from ?? ""}/${entry.slug}`} entry={entry} onInstalled={afterInstall} />;
    } else if (installed.some((i) => i.name === route.slug)) {
      page = (
        <NotFound
          text="This integration is already installed."
          action="Open it"
          onAction={() => navigate({ view: "installed", slug: route.slug, tab: "overview", q: "" })}
        />
      );
    } else if (route.from !== null && data.catalogs === null) {
      page = <SkeletonRows rows={6} />;
    } else {
      page = (
        <NotFound
          text="The catalog has no integration by this name."
          action="Back to the catalog"
          onAction={() => navigate(INTEGRATIONS_CATALOG)}
        />
      );
    }
  }

  const list = (
    <ListPane
      route={route}
      navigate={navigate}
      installed={installed}
      usage={data.usage}
      updates={updates}
      catalog={catalog}
      loading={loading}
    />
  );

  if (isMobile) {
    return selected ? (
      <div className="min-h-0 flex-1 overflow-y-auto" data-scrollable>
        <div className="px-4 pb-16 pt-4">
          <button
            type="button"
            className="mb-5 flex items-center gap-1.5 text-sm text-muted-foreground"
            onClick={() =>
              navigate(route.view === "catalog" ? { ...INTEGRATIONS_CATALOG, q: route.q } : INTEGRATIONS_HOME)
            }
          >
            <ArrowLeft className="size-4" /> {route.view === "catalog" ? "Catalog" : "Integrations"}
          </button>
          {page}
        </div>
      </div>
    ) : (
      <div className="flex min-h-0 flex-1 flex-col bg-sidebar">{list}</div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1">
      <div className="w-[19rem] shrink-0 border-r border-border bg-sidebar">{list}</div>
      <main className="min-w-0 flex-1 overflow-y-auto" data-scrollable>
        <div className="w-full max-w-[90rem] px-8 pb-20 pt-10 lg:px-12 2xl:px-16">{page}</div>
      </main>
    </div>
  );
}

function NotFound({ text, action, onAction }: { text: string; action: string; onAction: () => void }) {
  return (
    <div className="pt-6">
      <p className="text-base">{text}</p>
      <button type="button" className="mt-3 text-sm underline-offset-2 hover:underline" onClick={onAction}>
        {action}
      </button>
    </div>
  );
}
