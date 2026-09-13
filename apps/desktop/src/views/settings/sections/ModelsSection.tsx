//! ModelsSection — provider keys and model routes. Routes are a data table;
//! keys sit in a card with dialog-driven add/delete; the route detail page
//! shows the saved route as fact cards with an explicit edit form.

import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import type { SectionDetailProps } from "../section-nav";
import { useCachedGet } from "../use-cached-api";
import { Key, Plus, Trash2, Waypoints } from "lucide-react";
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
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@guild/ui/components/dialog";
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
  modalities: string[];
}

interface KeyRow {
  provider: string;
  base_url: string;
}

type View = { kind: "list" } | { kind: "detail"; model: string } | { kind: "add" };

const fmtUsd = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}/Mtok`;

const MODALITIES = ["image", "audio", "video"] as const;

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
  const keysRes = useCachedGet<{ keys: KeyRow[] }>("/api/v1/admin/gateway/keys");
  const routes = routesRes.data?.routes ?? null;
  const keys = keysRes.data?.keys ?? null;
  const error = routesRes.error;
  const reload = useMemo(
    () => () => {
      routesRes.reload();
      keysRes.reload();
    },
    [routesRes.reload, keysRes.reload],
  );
  const [addKeyOpen, setAddKeyOpen] = useState(false);
  // URL-driven view: null = list, "add" = add flow, otherwise the model id.
  const view: View =
    detail === null ? { kind: "list" } : detail === "add" ? { kind: "add" } : { kind: "detail", model: detail };

  const columns = useMemo<ColumnDef<RouteRow, any>[]>(
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
        cell: ({ row }) => <Chip>{row.original.provider}</Chip>,
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
    [],
  );

  if (view.kind === "detail") {
    return (
      <RouteDetail
        model={view.model}
        onChanged={() => reload()}
        onBack={() => {
          reload();
          onDetailChange(null);
        }}
      />
    );
  }
  if (view.kind === "add") {
    return (
      <RouteAdd
        onAdded={(model) => {
          reload();
          onDetailChange(model);
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
          description="Provider keys and model routes — what chats can select."
        />
        {error && <p className="mb-3 text-sm text-destructive">{error}</p>}

        {/* provider keys */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium">Provider keys</h3>
            <Button
              size="sm"
              variant="outline"
              className="h-8"
              onClick={() => setAddKeyOpen(true)}
            >
              <Plus className="size-3.5" /> Add key
            </Button>
          </div>
          {keys === null ? (
            <Skeleton className="h-14 w-full rounded-lg" />
          ) : keys.length === 0 ? (
            <EmptyState
              icon={Key}
              title="No provider keys"
              hint="Add a key to enable model calls for a provider."
              action={
                <Button size="sm" variant="outline" onClick={() => setAddKeyOpen(true)}>
                  <Plus className="size-3.5" /> Add key
                </Button>
              }
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              {keys.map((k) => (
                <div
                  key={k.provider}
                  className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
                >
                  <Key className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{k.provider}</p>
                    <p className="truncate text-xs text-muted-foreground">{k.base_url}</p>
                  </div>
                  <KeyDelete provider={k.provider} onChanged={reload} />
                </div>
              ))}
            </div>
          )}
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
            columns={columns}
            data={routes}
            search={(r) => `${r.model} ${r.provider}`}
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

      <AddKey
        open={addKeyOpen}
        onOpenChange={setAddKeyOpen}
        onChanged={reload}
      />
    </div>
  );
}

function KeyDelete({ provider, onChanged }: { provider: string; onChanged: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
        title={`Delete ${provider} key`}
        onClick={() => setConfirm(true)}
      >
        <Trash2 className="size-3.5" />
      </Button>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {provider} key?</AlertDialogTitle>
            <AlertDialogDescription>
              Models on this provider stop working until a new key is added. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api("DELETE", `/api/v1/admin/gateway/keys/${encodeURIComponent(provider)}`);
                  toast.success("Key deleted", { description: provider });
                  onChanged();
                  setConfirm(false);
                } catch (e) {
                  const msg = e instanceof Error ? e.message : String(e);
                  toast.error("Delete failed", { description: msg });
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Deleting…" : "Delete key"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function AddKey({
  open,
  onOpenChange,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const [provider, setProvider] = useState("openai");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("POST", "/api/v1/admin/gateway/keys", {
        provider,
        base_url: baseUrl,
        key,
      });
      toast.success("Key added", { description: provider });
      setKey("");
      onOpenChange(false);
      onChanged();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error("Could not add key", { description: msg });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Add provider key</DialogTitle>
          <DialogDescription>
            The key is stored server-side; the UI only sees the provider and base URL.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <Field label="Provider">
            <Input value={provider} onChange={(e) => setProvider(e.target.value)} />
          </Field>
          <Field label="Base URL">
            <Input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
          </Field>
          <Field label="API key">
            <Input type="password" value={key} placeholder="sk-…" onChange={(e) => setKey(e.target.value)} />
          </Field>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={!key || busy} onClick={save}>
              {busy ? "Saving…" : "Save key"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function useRouteField(model: string) {
  const res = useCachedGet<{ routes: RouteRow[] }>("/api/v1/admin/gateway/routes");
  return useMemo(
    () => res.data?.routes.find((x) => x.model === model) ?? null,
    [res.data, model],
  );
}

function RouteDetail({
  model,
  onChanged,
  onBack,
}: {
  model: string;
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
          <Field label="Model id">
            <Input value={draft.model} onChange={(e) => patch({ model: e.target.value })} />
          </Field>
          <Field label="Provider">
            <Select value={draft.provider} onValueChange={(v) => patch({ provider: v })}>
              <SelectTrigger className="max-w-48">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">openai</SelectItem>
                <SelectItem value="anthropic">anthropic</SelectItem>
              </SelectContent>
            </Select>
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
            <Chip>{r.provider}</Chip>
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
  onAdded,
  onBack,
}: {
  onAdded: (model: string) => void;
  onBack: () => void;
}) {
  const [model, setModel] = useState("");
  const [provider, setProvider] = useState("openai");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
        <Field label="Provider">
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger className="max-w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="openai">openai</SelectItem>
              <SelectItem value="anthropic">anthropic</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          <Button
            disabled={!model.trim() || busy}
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
