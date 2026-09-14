//! ModelsSection — providers and model routes. Both are editable objects with
//! their own URL-addressed sub-pages: a provider pairs a display name with a
//! wire protocol ("openai" names a protocol, not a provider) plus base URL
//! and key; a route maps a model id onto a provider.

import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import type { SectionDetailProps } from "../section-nav";
import { useCachedGet } from "../use-cached-api";
import { Blocks, Plus, Trash2, Waypoints } from "lucide-react";
import { toast } from "sonner";
import { api } from "../admin-api";
import { Button } from "@guild/ui/components/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@guild/ui/components/alert-dialog";
import { DataTable } from "@guild/ui/components/data-table";
import { Badge } from "@guild/ui/components/badge";
import { Input } from "@guild/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@guild/ui/components/select";
import { Skeleton } from "@guild/ui/components/skeleton";
import { PageHeader } from "../components/page-header";
import { Field } from "../components/field";
import { EmptyState } from "../components/empty-state";
import { FactCard, FactGrid } from "../components/fact-card";

interface RouteRow {
  model: string;
  provider: string;
  enabled: boolean;
  price_per_mtok_in_usd: number;
  price_per_mtok_out_usd: number;
  quota_monthly_usd: number | null;
  reasoning: boolean;
  context_window: number | null;
  max_output_tokens: number | null;
  modalities: string[];
}

interface ProviderRow {
  provider: string;
  name: string;
  protocol: string;
  base_url: string;
}

type View =
  | { kind: "list" }
  | { kind: "route-add" }
  | { kind: "route"; model: string }
  | { kind: "provider-add" }
  | { kind: "provider"; slug: string };

function parseView(detail: string | null | undefined): View {
  if (detail == null) return { kind: "list" };
  if (detail === "add") return { kind: "route-add" };
  if (detail.startsWith("provider/")) {
    const slug = detail.slice("provider/".length);
    return slug === "new" ? { kind: "provider-add" } : { kind: "provider", slug };
  }
  return { kind: "route", model: detail };
}

const fmtUsd = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}/Mtok`;

const MODALITIES = ["image", "audio", "video"] as const;
const PROTOCOLS = ["openai", "anthropic"] as const;

function StatusDot({ enabled }: { enabled: boolean }) {
  return (
    <span
      className={`inline-block size-2 shrink-0 rounded-full ${
        enabled ? "bg-emerald-500" : "bg-muted-foreground/40"
      }`}
      title={enabled ? "enabled" : "disabled"}
    />
  );
}

function Chip({ children }: { children: string }) {
  return <Badge variant="secondary" className="uppercase">{children}</Badge>;
}

export default function ModelsSection({
  detail = null,
  onDetailChange,
}: SectionDetailProps) {
  const routesRes = useCachedGet<{ routes: RouteRow[] }>("/api/v1/admin/gateway/routes");
  const providersRes = useCachedGet<{ providers: ProviderRow[] }>(
    "/api/v1/admin/gateway/providers",
  );
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

  const providerName = (slug: string) =>
    providers?.find((p) => p.provider === slug)?.name ?? slug;

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
        cell: ({ row }) => (
          <span className="block truncate text-muted-foreground">{row.original.base_url}</span>
        ),
      },
    ],
    [],
  );

  const routeColumns = useMemo<ColumnDef<RouteRow, any>[]>(
    () => [
      {
        accessorKey: "model",
        header: "Model",
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-2">
            <StatusDot enabled={row.original.enabled} />
            <span className="truncate font-medium">{row.original.model}</span>
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
            {fmtUsd(row.original.price_per_mtok_in_usd)} in ·{" "}
            {fmtUsd(row.original.price_per_mtok_out_usd)} out
          </span>
        ),
      },
      {
        accessorKey: "context_window",
        header: "Context",
        cell: ({ row }) => (
          <span className="tabular-nums text-muted-foreground">
            {row.original.context_window != null
              ? `${(row.original.context_window / 1000).toFixed(0)}k`
              : "—"}
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [providers],
  );

  if (view.kind === "route") {
    return (
      <RouteDetail
        model={view.model}
        providers={providers}
        onChanged={() => reload()}
        onBack={() => {
          reload();
          onDetailChange(null);
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
          onDetailChange(model);
        }}
        onBack={() => onDetailChange(null)}
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
          onDetailChange(null);
        }}
      />
    );
  }
  if (view.kind === "provider-add") {
    return (
      <ProviderAdd
        onCreated={(slug) => {
          reload();
          onDetailChange(`provider/${slug}`);
        }}
        onBack={() => onDetailChange(null)}
      />
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <PageHeader
          title="Models"
          description="Providers and model routes — what chats can select."
        />
        {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

        {/* providers */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Providers</h3>
            <Button size="sm" className="h-8" onClick={() => onDetailChange("provider/new")}>
              <Plus className="size-3.5" /> Add provider
            </Button>
          </div>
          <DataTable
            columns={providerColumns}
            data={providers}
            search={(p) => `${p.name} ${p.provider} ${p.base_url}`}
            searchPlaceholder="Search providers…"
            onRowClick={(p) => onDetailChange(`provider/${p.provider}`)}
            empty={
              <EmptyState
                icon={Blocks}
                title="No providers"
                hint="A provider pairs a name with a wire protocol, base URL and API key."
                action={
                  <Button size="sm" onClick={() => onDetailChange("provider/new")}>
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
            <Button size="sm" className="h-8" onClick={() => onDetailChange("add")}>
              <Plus className="size-3.5" /> Add model
            </Button>
          </div>
          <DataTable
            columns={routeColumns}
            data={routes}
            search={(r) => `${r.model} ${providerName(r.provider)}`}
            searchPlaceholder="Search models…"
            onRowClick={(r) => onDetailChange(r.model)}
            empty={
              <EmptyState
                icon={Waypoints}
                title="No model routes"
                hint="Add a route to make a model selectable in chats."
                action={
                  <Button size="sm" onClick={() => onDetailChange("add")}>
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

function useProviders(): { providers: ProviderRow[] | null } {
  const res = useCachedGet<{ providers: ProviderRow[] }>("/api/v1/admin/gateway/providers");
  return { providers: res.data?.providers ?? null };
}

/// Shared provider form fields for the add and edit screens.
function ProviderFormFields({
  name,
  protocol,
  baseUrl,
  key,
  keyHint,
  onPatch,
}: {
  name: string;
  protocol: string;
  baseUrl: string;
  key: string;
  keyHint: string;
  onPatch: (p: { name?: string; protocol?: string; baseUrl?: string; key?: string }) => void;
}) {
  return (
    <>
      <Field label="Name" hint="Your label for this endpoint — routes reference it by its slug.">
        <Input value={name} placeholder="e.g. DeepSeek via OpenRouter" onChange={(e) => onPatch({ name: e.target.value })} />
      </Field>
      <Field label="Protocol" hint="The wire shape the endpoint speaks.">
        <Select value={protocol} onValueChange={(v) => onPatch({ protocol: v })}>
          <SelectTrigger className="max-w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PROTOCOLS.map((p) => (
              <SelectItem key={p} value={p}>{p}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label="Base URL">
        <Input value={baseUrl} placeholder="https://api.openai.com" onChange={(e) => onPatch({ baseUrl: e.target.value })} />
      </Field>
      <Field label="API key" hint={keyHint}>
        <Input type="password" value={key} placeholder="sk-…" onChange={(e) => onPatch({ key: e.target.value })} />
      </Field>
    </>
  );
}

function ProviderAdd({
  onCreated,
  onBack,
}: {
  onCreated: (slug: string) => void;
  onBack: () => void;
}) {
  const [name, setName] = useState("");
  const [protocol, setProtocol] = useState<string>("openai");
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ provider: string }>("POST", "/api/v1/admin/gateway/providers", {
        name: name.trim(),
        protocol,
        base_url: baseUrl.trim(),
        key,
      });
      toast.success("Provider created", { description: name.trim() });
      onCreated(res.provider);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error("Could not create provider", { description: msg });
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Add a provider"
        description="The provider gets a stable slug derived from the name; model routes reference that slug."
        back={{ label: "Models", onClick: onBack }}
      />
      <div className="max-w-xl space-y-5 rounded-lg border border-border bg-card p-5">
        <ProviderFormFields
          name={name}
          protocol={protocol}
          baseUrl={baseUrl}
          key={key}
          keyHint="Stored server-side; never returned to the UI."
          onPatch={(p) => {
            if (p.name !== undefined) setName(p.name);
            if (p.protocol !== undefined) setProtocol(p.protocol);
            if (p.baseUrl !== undefined) setBaseUrl(p.baseUrl);
            if (p.key !== undefined) setKey(p.key);
          }}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          <Button disabled={!name.trim() || !baseUrl.trim() || !key || busy} onClick={create}>
            {busy ? "Creating…" : "Create provider"}
          </Button>
          <Button variant="ghost" onClick={onBack}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

function ProviderDetail({
  slug,
  onChanged,
  onBack,
}: {
  slug: string;
  onChanged: () => void;
  onBack: () => void;
}) {
  const { providers } = useProviders();
  const p = useMemo(
    () => providers?.find((x) => x.provider === slug) ?? null,
    [providers, slug],
  );
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draft, setDraft] = useState<{ name: string; protocol: string; baseUrl: string; key: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // adopt the loaded row into the draft once (edits are local until saved)
  useEffect(() => {
    if (p && draft === null && mode === "edit") {
      setDraft({ name: p.name, protocol: p.protocol, baseUrl: p.base_url, key: "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, mode]);

  if (providers !== null && p === null) {
    return (
      <div>
        <PageHeader title="Provider not found" back={{ label: "Models", onClick: onBack }} />
        <EmptyState
          icon={Blocks}
          title={`No provider "${slug}"`}
          hint="It may have been deleted. Routes that referenced it stop resolving."
        />
      </div>
    );
  }
  if (p === null) {
    return (
      <div>
        <PageHeader title={slug} back={{ label: "Models", onClick: onBack }} />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    setError(null);
    try {
      await api("PUT", `/api/v1/admin/gateway/providers/${encodeURIComponent(slug)}`, {
        name: draft.name.trim(),
        protocol: draft.protocol,
        base_url: draft.baseUrl.trim(),
        ...(draft.key ? { key: draft.key } : {}),
      });
      toast.success("Provider saved", { description: draft.name.trim() });
      onChanged();
      setDraft(null);
      setMode("view");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error("Save failed", { description: msg });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api("DELETE", `/api/v1/admin/gateway/providers/${encodeURIComponent(slug)}`);
      toast.success("Provider deleted", { description: p.name });
      onBack();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("Delete failed", { description: msg });
      setBusy(false);
    }
  };

  if (mode === "edit") {
    if (draft === null) {
      return (
        <div>
          <PageHeader title={slug} back={{ label: "Models", onClick: onBack }} />
          <Skeleton className="h-40 w-full rounded-lg" />
        </div>
      );
    }
    return (
      <div>
        <PageHeader
          title="Edit provider"
          description={slug}
          back={{ label: "Models", onClick: onBack }}
        />
        <div className="max-w-xl space-y-5 rounded-lg border border-border bg-card p-5">
          <ProviderFormFields
            name={draft.name}
            protocol={draft.protocol}
            baseUrl={draft.baseUrl}
            key={draft.key}
            keyHint="Leave blank to keep the stored key."
            onPatch={(patch) => setDraft({ ...draft, ...patch })}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <Button disabled={busy || !draft.name.trim() || !draft.baseUrl.trim()} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(null);
                setError(null);
                setMode("view");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title={p.name}
        description={`Speaks the ${p.protocol} protocol.`}
        back={{ label: "Models", onClick: onBack }}
        actions={
          <>
            <Button onClick={() => setMode("edit")}>Edit</Button>
            <Button variant="outline" className="text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
          </>
        }
      />
      <FactGrid>
        <FactCard label="Name">
          <span>{p.name}</span>
        </FactCard>
        <FactCard label="Protocol">
          <Chip>{p.protocol}</Chip>
        </FactCard>
        <FactCard label="Base URL">
          <span className="break-all">{p.base_url}</span>
        </FactCard>
        <FactCard label="Slug — routes reference this id">
          <span className="font-mono text-sm">{p.provider}</span>
        </FactCard>
      </FactGrid>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {p.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Model routes on this provider stop resolving until a provider with the same slug
              exists again. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
              onClick={remove}
            >
              {busy ? "Deleting…" : "Delete provider"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function useRouteField(model: string) {
  const res = useCachedGet<{ routes: RouteRow[] }>("/api/v1/admin/gateway/routes");
  return useMemo(
    () => res.data?.routes.find((x) => x.model === model) ?? null,
    [res.data, model],
  );
}

/// Provider picker shared by route add + edit: value is the provider slug,
/// label the display name.
function ProviderSelect({
  providers,
  value,
  onChange,
}: {
  providers: ProviderRow[] | null;
  value: string;
  onChange: (slug: string) => void;
}) {
  if (providers === null) {
    return <Skeleton className="h-9 max-w-48 rounded-md" />;
  }
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="max-w-72">
        <SelectValue placeholder="Pick a provider" />
      </SelectTrigger>
      <SelectContent>
        {providers.map((p) => (
          <SelectItem key={p.provider} value={p.provider}>
            {p.name} ({p.protocol})
          </SelectItem>
        ))}
        {/* a route may reference a deleted provider — keep it selectable so
            saving doesn't silently repoint the route */}
        {!providers.some((x) => x.provider === value) && value && (
          <SelectItem value={value}>{value} (deleted)</SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}

function RouteDetail({
  model,
  providers,
  onChanged,
  onBack,
}: {
  model: string;
  providers: ProviderRow[] | null;
  onChanged: () => void;
  onBack: () => void;
}) {
  const r = useRouteField(model);
  // The saved route is facts first; editing is an explicit draft mode.
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draft, setDraft] = useState<RouteRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // adopt the loaded row into the draft once (edits are local until saved)
  useEffect(() => {
    if (r && draft === null) setDraft(r);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [r]);

  if (r === null || draft === null) {
    return (
      <div>
        <PageHeader title={model} back={{ label: "Models", onClick: onBack }} />
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }
  const patch = (p: Partial<RouteRow>) => setDraft({ ...draft, ...p });
  const providerName = providers?.find((x) => x.provider === r.provider)?.name ?? r.provider;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("PUT", "/api/v1/admin/gateway/routes", {
        model: draft.model,
        provider: draft.provider,
        enabled: draft.enabled,
        price_in: draft.price_per_mtok_in_usd,
        price_out: draft.price_per_mtok_out_usd,
        ...(draft.quota_monthly_usd != null ? { quota_monthly_usd: draft.quota_monthly_usd } : {}),
        reasoning: draft.reasoning,
        ...(draft.context_window != null ? { context_window: draft.context_window } : {}),
        ...(draft.max_output_tokens != null
          ? { max_output_tokens: draft.max_output_tokens }
          : {}),
        modalities: draft.modalities,
      });
      toast.success("Route saved", { description: draft.model });
      onChanged();
      setDraft(null);
      setMode("view");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error("Save failed", { description: msg });
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api("DELETE", `/api/v1/admin/gateway/routes/${encodeURIComponent(model)}`);
      toast.success("Route deleted", { description: r.model });
      onBack();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("Delete failed", { description: msg });
      setBusy(false);
    }
  };

  if (mode === "edit") {
    return (
      <div>
        <PageHeader
          title="Edit route"
          description={draft.model}
          back={{ label: "Models", onClick: onBack }}
        />
        <div className="max-w-xl space-y-5 rounded-lg border border-border bg-card p-5">
          <Field label="Model id" hint="Immutable — the id keys the route; editing it would create a second route.">
            <Input value={draft.model} disabled />
          </Field>
          <Field label="Provider">
            <ProviderSelect
              providers={providers}
              value={draft.provider}
              onChange={(v) => patch({ provider: v })}
            />
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-foreground"
              checked={draft.enabled}
              onChange={(e) => patch({ enabled: e.target.checked })}
            />
            Enabled — selectable in chats
          </label>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Price in, $/Mtok">
              <Input
                value={String(draft.price_per_mtok_in_usd)}
                onChange={(e) => patch({ price_per_mtok_in_usd: Number(e.target.value) || 0 })}
              />
            </Field>
            <Field label="Price out, $/Mtok">
              <Input
                value={String(draft.price_per_mtok_out_usd)}
                onChange={(e) => patch({ price_per_mtok_out_usd: Number(e.target.value) || 0 })}
              />
            </Field>
            <Field label="Monthly cap, USD" hint="Empty = unlimited.">
              <Input
                value={draft.quota_monthly_usd != null ? String(draft.quota_monthly_usd) : ""}
                placeholder="unlimited"
                onChange={(e) =>
                  patch({
                    quota_monthly_usd: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </Field>
            <Field label="Context window" hint="Tokens; empty = provider default.">
              <Input
                value={draft.context_window != null ? String(draft.context_window) : ""}
                placeholder="128000"
                onChange={(e) =>
                  patch({ context_window: e.target.value === "" ? null : Number(e.target.value) })
                }
              />
            </Field>
            <Field label="Max output tokens" hint="Per model call; empty = provider default. Anthropic requires this when you want long answers.">
              <Input
                value={draft.max_output_tokens != null ? String(draft.max_output_tokens) : ""}
                placeholder="4096"
                onChange={(e) =>
                  patch({
                    max_output_tokens: e.target.value === "" ? null : Number(e.target.value),
                  })
                }
              />
            </Field>
          </div>
          <Field label="Capabilities">
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  className="size-4 accent-foreground"
                  checked={draft.reasoning}
                  onChange={(e) => patch({ reasoning: e.target.checked })}
                />
                reasoning
              </label>
              {MODALITIES.map((m) => (
                <label key={m} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="size-4 accent-foreground"
                    checked={draft.modalities.includes(m)}
                    onChange={(e) =>
                      patch({
                        modalities: e.target.checked
                          ? [...draft.modalities, m]
                          : draft.modalities.filter((x) => x !== m),
                      })
                    }
                  />
                  {m}
                </label>
              ))}
            </div>
          </Field>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex items-center gap-2">
            <Button disabled={busy} onClick={save}>
              {busy ? "Saving…" : "Save"}
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                setDraft(r);
                setError(null);
                setMode("view");
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // view: saved route as facts + explicit actions
  return (
    <div>
      <PageHeader
        title={r.model}
        description={
          r.enabled ? "Selectable in chats." : "Disabled — not selectable in chats."
        }
        back={{ label: "Models", onClick: onBack }}
        actions={
          <>
            <Button onClick={() => setMode("edit")}>Edit</Button>
            <Button variant="outline" className="text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
          </>
        }
      />
      <FactGrid>
        <FactCard label="Provider">
          <div className="flex items-center gap-2">
            <Chip>{providerName}</Chip>
            <StatusDot enabled={r.enabled} />
            <span className="text-sm text-muted-foreground">{r.enabled ? "enabled" : "disabled"}</span>
          </div>
        </FactCard>
        <FactCard label="Pricing">
          <span className="tabular-nums">
            {fmtUsd(r.price_per_mtok_in_usd)} in · {fmtUsd(r.price_per_mtok_out_usd)} out
            {r.quota_monthly_usd != null ? ` · cap ${fmtUsd(r.quota_monthly_usd)}/mo` : " · no cap"}
          </span>
        </FactCard>
        <FactCard label="Context window">
          {r.context_window != null
            ? `${(r.context_window / 1000).toFixed(0)}k tokens`
            : "provider default"}
        </FactCard>
        <FactCard label="Capabilities">
          <div className="flex flex-wrap gap-1.5">
            {r.reasoning && <Chip>reasoning</Chip>}
            {r.modalities.map((m) => (
              <Chip key={m}>{m}</Chip>
            ))}
            {!r.reasoning && r.modalities.length === 0 && (
              <span className="text-sm text-muted-foreground">text only</span>
            )}
          </div>
        </FactCard>
      </FactGrid>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete route?</AlertDialogTitle>
            <AlertDialogDescription>
              {r.model} disappears from the chat model selector. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
              onClick={remove}
            >
              {busy ? "Deleting…" : "Delete route"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function RouteAdd({
  providers,
  onAdded,
  onBack,
}: {
  providers: ProviderRow[] | null;
  onAdded: (model: string) => void;
  onBack: () => void;
}) {
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // default the picker to the first provider once the list loads
  useEffect(() => {
    if (provider === "" && providers && providers.length > 0) setProvider(providers[0].provider);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers]);

  return (
    <div>
      <PageHeader
        title="Add a model route"
        description="The route is created enabled with zero pricing; open it from the list to set pricing, context window and capabilities."
        back={{ label: "Models", onClick: onBack }}
      />
      <div className="max-w-xl space-y-5 rounded-lg border border-border bg-card p-5">
        <Field label="Model id">
          <Input
            value={model}
            placeholder="e.g. GLM-5.3-Flash"
            onChange={(e) => setModel(e.target.value)}
          />
        </Field>
        <Field
          label="Provider"
          hint={providers !== null && providers.length === 0 ? "Add a provider first." : undefined}
        >
          <ProviderSelect providers={providers} value={provider} onChange={setProvider} />
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          <Button
            disabled={!model.trim() || !provider || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api("PUT", "/api/v1/admin/gateway/routes", {
                  model: model.trim(),
                  provider,
                  enabled: true,
                  price_in: 0,
                  price_out: 0,
                  reasoning: false,
                  modalities: [],
                });
                toast.success("Route created", { description: model.trim() });
                onAdded(model.trim());
              } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                setError(msg);
                toast.error("Could not create route", { description: msg });
                setBusy(false);
              }
            }}
          >
            {busy ? "Creating…" : "Create route"}
          </Button>
          <Button variant="ghost" onClick={onBack}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}
