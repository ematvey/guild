//! The Models section's route pages (add, detail). A route maps a model id
//! onto a provider; the detail page shows the saved route as facts and Edit
//! seeds a local draft from it.

import { useState } from "react";
import { updateCached, useCachedGet } from "../use-cached-api";
import {
  deleteGatewayRoute,
  putGatewayRoute,
  SETTINGS_PATHS,
} from "../../../lib/api/settings";
import { Blocks, Trash2 } from "lucide-react";
import { toast } from "sonner";
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
import { Input } from "@guild/ui/components/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@guild/ui/components/select";
import { Skeleton, SkeletonForm } from "@guild/ui/components/skeleton";
import { PageHeader } from "../components/page-header";
import { Field } from "../components/field";
import { EmptyState } from "@guild/ui/components/empty-state";
import { FactCard, FactGrid } from "../components/fact-card";


import {
  Chip,
  fmtUsd,
  MODALITIES,
  StatusDot,
  type ProviderRow,
  type RouteRow,
} from "./model-providers";

function useRouteField(model: string) {
  const res = useCachedGet<{ routes: RouteRow[] }>(SETTINGS_PATHS.gatewayRoutes);
  return { route: res.data?.routes.find((x) => x.model === model) ?? null, settled: res.settled, error: res.error };
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

export function RouteDetail({
  model,
  providers,
  onChanged,
  onRenamed,
  onBack,
}: {
  model: string;
  providers: ProviderRow[] | null;
  onChanged: () => void;
  onRenamed: (model: string) => void;
  onBack: () => void;
}) {
  const { route: r, settled, error: loadError } = useRouteField(model);
  // The saved route is facts first; editing is an explicit draft mode.
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [draft, setDraft] = useState<RouteRow | null>(null);
  // The temperature field edits as raw text so a mid-typing value like "0."
  // survives re-renders (Number("0.") would collapse it to "0"); parsed on save.
  const [tempText, setTempText] = useState<string>("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (r === null) {
    if (loadError) return <p role="alert" className="text-sm text-destructive">{loadError}</p>;
    if (settled && r === null) return <EmptyState icon={Blocks} title="Route not found" hint="It may have been deleted." />;
    return (
      <div>
        <PageHeader title={model} back={{ label: "Models", onClick: onBack }} />
        <SkeletonForm />
      </div>
    );
  }
  const patch = (p: Partial<RouteRow>) => setDraft((d) => (d === null ? d : { ...d, ...p }));
  const providerName = providers?.find((x) => x.provider === r.provider)?.name ?? r.provider;

  const save = async () => {
    if (draft === null) return;
    setBusy(true);
    setError(null);
    try {
      // Empty = provider default; otherwise accept any decimal the user
      // typed and let the server's (0, 2] validation reject garbage.
      const parsedTemp = tempText.trim() === "" ? null : Number(tempText.trim());
      if (parsedTemp !== null && (!Number.isFinite(parsedTemp) || parsedTemp <= 0 || parsedTemp > 2)) {
        setError("Temperature must be within (0, 2]");
        setBusy(false);
        return;
      }
      await putGatewayRoute({
        original_model: model,
        model: draft.model.trim(),
        alias: draft.alias.trim(),
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
        ...(draft.temperature != null || tempText.trim() !== "" ? { temperature: parsedTemp } : {}),
        modalities: draft.modalities,
      });
      const saved: RouteRow = {
        ...draft,
        model: draft.model.trim(),
        alias: draft.alias.trim(),
        temperature: parsedTemp,
      };
      updateCached<{ routes: RouteRow[] }>(SETTINGS_PATHS.gatewayRoutes, (value) => ({
        ...value,
        routes: value.routes.map((row) => (row.model === model ? saved : row)),
      }));
      toast.success("Route saved", { description: saved.alias || saved.model });
      onChanged();
      if (draft.model.trim() !== model) onRenamed(draft.model.trim());
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
      await deleteGatewayRoute(model);
      toast.success("Route deleted", { description: r.alias || r.model });
      onBack();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("Delete failed", { description: msg });
      setBusy(false);
    }
  };

  if (mode === "edit" && draft !== null) {
    return (
      <div>
        <PageHeader
          title="Edit route"
          description={draft.alias || draft.model}
          back={{ label: "Models", onClick: onBack }}
        />
        <div className="max-w-xl space-y-5 rounded-lg border border-border bg-card p-5">
          <Field
            label="Display name"
            hint="Shown to chat users. The model id stays internal."
          >
            <Input
              value={draft.alias}
              placeholder="e.g. Guild Fast"
              onChange={(e) => patch({ alias: e.target.value })}
            />
          </Field>
          <Field
            label="Model id"
            hint="The name sent to the provider and used by API clients. Changing it renames the route in place."
          >
            <Input value={draft.model} onChange={(e) => patch({ model: e.target.value })} />
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
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
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
            <Field label="Temperature" hint="Sampling temperature, 0–2; empty = provider default. Lower (0.6) makes long tool-call scripts reliable; a client that sends its own temperature overrides it.">
              <Input
                value={tempText}
                inputMode="decimal"
                placeholder="default"
                onChange={(e) => setTempText(e.target.value)}
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
            <Button
              disabled={busy || !draft.model.trim() || !draft.alias.trim()}
              onClick={save}
            >
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
        title={r.alias || r.model}
        description={
          r.enabled ? "Selectable in chats." : "Disabled — not selectable in chats."
        }
        back={{ label: "Models", onClick: onBack }}
        actions={
          <>
            <Button
              onClick={() => {
                setDraft(r);
                setTempText(r.temperature != null ? String(r.temperature) : "");
                setMode("edit");
              }}
            >
              Edit
            </Button>
            <Button variant="outline" className="text-destructive" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
          </>
        }
      />
      <FactGrid>
        <FactCard label="Display name">
          <span>{r.alias || "not set — users see the model id"}</span>
        </FactCard>
        <FactCard label="Model id">
          <span className="font-mono text-sm">{r.model}</span>
        </FactCard>
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
              {r.alias || r.model} disappears from the chat model selector. This cannot be undone.
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

export function RouteAdd({
  providers,
  onAdded,
  onBack,
}: {
  providers: ProviderRow[] | null;
  onAdded: (model: string) => void;
  onBack: () => void;
}) {
  const [model, setModel] = useState("");
  const [alias, setAlias] = useState("");
  const [picked, setProvider] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The picker defaults to the first provider once the list loads.
  const provider = picked || (providers?.[0]?.provider ?? "");

  return (
    <div>
      <PageHeader
        title="Add a model route"
        description="The route is created enabled with zero pricing; open it from the list to set pricing, context window and capabilities."
        back={{ label: "Models", onClick: onBack }}
      />
      <div className="max-w-xl space-y-5 rounded-lg border border-border bg-card p-5">
        <Field
          label="Display name"
          hint="Shown to chat users. The model id stays internal."
        >
          <Input
            value={alias}
            placeholder="e.g. Guild Fast"
            onChange={(e) => setAlias(e.target.value)}
          />
        </Field>
        <Field label="Model id" hint="The name sent to the provider and used by API clients.">
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
            disabled={!model.trim() || !alias.trim() || !provider || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await putGatewayRoute({
                  model: model.trim(),
                  alias: alias.trim(),
                  provider,
                  enabled: true,
                  price_in: 0,
                  price_out: 0,
                  reasoning: false,
                  modalities: [],
                });
                toast.success("Route created", { description: alias.trim() });
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
