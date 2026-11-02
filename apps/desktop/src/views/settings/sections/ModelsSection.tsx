//! ModelsSection — providers and model routes. Both are editable objects with
//! their own URL-addressed sub-pages: a provider pairs a display name with a
//! wire protocol ("openai" names a protocol, not a provider) plus base URL
//! and key; a route maps a model id onto a provider.

import { useCallback, useMemo } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import type { DetailCodec, SectionDetailProps } from "../section-nav";
import { useCachedGet } from "../use-cached-api";
import { SETTINGS_PATHS } from "../../../lib/api/settings";
import { Blocks, Plus, Waypoints } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { DataTable } from "@guild/ui/components/data-table";
import { PageHeader } from "../../../components/page-header";
import { EmptyState } from "@guild/ui/components/empty-state";
import {
  Chip,
  fmtUsd,
  ProviderAdd,
  ProviderDetail,
  StatusDot,
  type ProviderRow,
  type RouteRow,
} from "./model-providers";
import { RouteAdd, RouteDetail } from "./model-routes";

type View =
  | { kind: "list" }
  | { kind: "route-add" }
  | { kind: "route"; model: string }
  | { kind: "provider-add" }
  | { kind: "provider"; slug: string };

function parseView(detail: string | null | undefined): View {
  return viewCodec.parse(detail ?? null);
}

/** The section's sub-page grammar: the wire stays an opaque string. */
const viewCodec: DetailCodec<View> = {
  parse(detail) {
    if (detail == null) return { kind: "list" };
    if (detail === "add") return { kind: "route-add" };
    if (detail.startsWith("provider/")) {
      const slug = detail.slice("provider/".length);
      return slug === "new" ? { kind: "provider-add" } : { kind: "provider", slug };
    }
    return { kind: "route", model: detail };
  },
  format(view) {
    switch (view.kind) {
      case "list":
        return null;
      case "route-add":
        return "add";
      case "route":
        return view.model;
      case "provider-add":
        return "provider/new";
      case "provider":
        return `provider/${view.slug}`;
    }
  },
};

export default function ModelsSection({ detail = null, onDetailChange }: SectionDetailProps) {
  const routesRes = useCachedGet<{ routes: RouteRow[] }>(SETTINGS_PATHS.gatewayRoutes);
  const providersRes = useCachedGet<{ providers: ProviderRow[] }>(SETTINGS_PATHS.gatewayProviders);
  const routes = routesRes.data?.routes ?? null;
  const providers = providersRes.data?.providers ?? null;
  const error = routesRes.error ?? providersRes.error;
  const reload = useMemo(
    () => () => {
      routesRes.reload();
      providersRes.reload();
    },
    [routesRes.reload, providersRes.reload],
  );
  // URL-driven view: the list, the route add flow, a route detail (model id),
  // or a provider page ("provider/new" | "provider/<slug>").
  const view = parseView(detail);
  const open = (next: View) => onDetailChange(viewCodec.format(next));

  const providerName = useCallback(
    (slug: string) => providers?.find((p) => p.provider === slug)?.name ?? slug,
    [providers],
  );

  const providerColumns = useMemo<ColumnDef<ProviderRow, any>[]>(
    () => [
      {
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => (
          <div className="min-w-0">
            <p className="truncate font-medium">{row.original.name}</p>
            <p className="truncate text-xs text-muted-foreground">{row.original.provider}</p>
          </div>
        ),
      },
      {
        accessorKey: "protocol",
        header: "Protocol",
        cell: ({ row }) => <Chip>{row.original.protocol}</Chip>,
      },
      {
        accessorKey: "base_url",
        header: "Base URL",
        cell: ({ row }) => <span className="block truncate text-muted-foreground">{row.original.base_url}</span>,
      },
    ],
    [],
  );

  const routeColumns = useMemo<ColumnDef<RouteRow, any>[]>(
    () => [
      {
        accessorKey: "alias",
        header: "Model",
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2">
            <StatusDot enabled={row.original.enabled} />
            <div className="min-w-0">
              <p className="truncate font-medium">{row.original.alias || row.original.model}</p>
              <p className="truncate text-xs text-muted-foreground">{row.original.model}</p>
            </div>
          </div>
        ),
      },
      {
        accessorKey: "provider",
        header: "Provider",
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2">
            <Chip>{providerName(row.original.provider)}</Chip>
          </div>
        ),
      },
      {
        id: "pricing",
        header: "Pricing",
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {fmtUsd(row.original.price_per_mtok_in_usd)} in · {fmtUsd(row.original.price_per_mtok_out_usd)} out
          </span>
        ),
      },
      {
        accessorKey: "context_window",
        header: "Context",
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {row.original.context_window != null ? `${(row.original.context_window / 1000).toFixed(0)}k` : "—"}
          </span>
        ),
      },
      {
        id: "capabilities",
        header: "Capabilities",
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.reasoning && <Chip>reasoning</Chip>}
            {row.original.modalities.map((m) => (
              <Chip key={m}>{m}</Chip>
            ))}
            {!row.original.reasoning && row.original.modalities.length === 0 && (
              <span className="text-muted-foreground">text</span>
            )}
          </div>
        ),
      },
    ],
    [providerName],
  );

  if (view.kind === "route") {
    return (
      <RouteDetail
        model={view.model}
        providers={providers}
        onChanged={() => reload()}
        onRenamed={(model) => open({ kind: "route", model })}
        onBack={() => {
          reload();
          open({ kind: "list" });
        }}
      />
    );
  }
  if (view.kind === "route-add") {
    return (
      <RouteAdd
        providers={providers}
        onAdded={(model) => {
          reload();
          open({ kind: "route", model });
        }}
        onBack={() => open({ kind: "list" })}
      />
    );
  }
  if (view.kind === "provider") {
    return (
      <ProviderDetail
        slug={view.slug}
        onChanged={() => reload()}
        onBack={() => {
          reload();
          open({ kind: "list" });
        }}
      />
    );
  }
  if (view.kind === "provider-add") {
    return (
      <ProviderAdd
        onCreated={(slug) => {
          reload();
          open({ kind: "provider", slug });
        }}
        onBack={() => open({ kind: "list" })}
      />
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <PageHeader title="Models" description="Providers and model routes — what chats can select." />
        {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

        {/* providers */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Providers</h3>
            <Button size="sm" className="h-8" onClick={() => open({ kind: "provider-add" })}>
              <Plus className="size-3.5" /> Add provider
            </Button>
          </div>
          <DataTable
            columns={providerColumns}
            data={providers}
            search={(p) => `${p.name} ${p.provider} ${p.base_url}`}
            searchPlaceholder="Search providers…"
            onRowClick={(p) => open({ kind: "provider", slug: p.provider })}
            empty={
              <EmptyState
                icon={Blocks}
                title="No providers"
                hint="A provider pairs a name with a wire protocol, base URL and API key."
                action={
                  <Button size="sm" onClick={() => open({ kind: "provider-add" })}>
                    <Plus className="size-3.5" /> Add provider
                  </Button>
                }
              />
            }
          />
        </section>

        {/* model routes */}
        <section className="mt-6 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Model routes</h3>
            <Button size="sm" className="h-8" onClick={() => open({ kind: "route-add" })}>
              <Plus className="size-3.5" /> Add model
            </Button>
          </div>
          <DataTable
            columns={routeColumns}
            data={routes}
            search={(r) => `${r.alias} ${r.model} ${providerName(r.provider)}`}
            searchPlaceholder="Search models…"
            onRowClick={(r) => open({ kind: "route", model: r.model })}
            empty={
              <EmptyState
                icon={Waypoints}
                title="No model routes"
                hint="Add a route to make a model selectable in chats."
                action={
                  <Button size="sm" onClick={() => open({ kind: "route-add" })}>
                    <Plus className="size-3.5" /> Add model
                  </Button>
                }
              />
            }
          />
        </section>
      </div>
    </div>
  );
}
