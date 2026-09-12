//! ModelsSection — admin settings: provider keys and model routes as a rich
//! list screen with separate add / detail (edit + delete) screens.

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Key, Pencil, Plus, Trash2 } from "lucide-react";
import { api } from "../admin-api";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";
import { Skeleton } from "@guild/ui/components/skeleton";

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

const listCard =
  "flex w-full items-center gap-3 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-accent/40";
const backBtn =
  "mb-4 flex items-center gap-1.5 text-base text-muted-foreground transition-colors hover:text-foreground";
const label = "text-xs font-medium uppercase tracking-wide text-muted-foreground";
const field =
  "h-9 w-full rounded-md border border-input bg-background px-3 text-base";
const row = "grid grid-cols-[130px_1fr] items-start gap-x-4 gap-y-3 py-2";

const fmtUsd = (n: number) => `$${n % 1 === 0 ? n.toFixed(0) : n.toFixed(2)}/Mtok`;

const MODALITIES = ["image", "audio", "video"] as const;

export default function ModelsSection() {
  const [routes, setRoutes] = useState<RouteRow[] | null>(null);
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "list" });

  const reload = useCallback(() => {
    api<{ routes: RouteRow[] }>("GET", "/api/v1/admin/gateway/routes")
      .then((r) => setRoutes(r.routes))
      .catch((e) => {
        setRoutes([]);
        setError(e instanceof Error ? e.message : String(e));
      });
    api<{ keys: KeyRow[] }>("GET", "/api/v1/admin/gateway/keys")
      .then((r) => setKeys(r.keys))
      .catch(() => setKeys([]));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  if (view.kind === "detail") {
    return (
      <RouteDetail
        model={view.model}
        onChanged={() => reload()}
        onBack={() => {
          reload();
          setView({ kind: "list" });
        }}
      />
    );
  }
  if (view.kind === "add") {
    return (
      <RouteAdd
        onAdded={(model) => {
          reload();
          setView({ kind: "detail", model });
        }}
        onBack={() => setView({ kind: "list" })}
      />
    );
  }

  return (
    <div className="space-y-6">
      {error && <p className="text-base text-destructive">{error}</p>}

      {/* provider keys */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className={label}>Provider keys</h3>
          <span className="text-xs text-muted-foreground">
            {keys ? `${keys.length} configured` : ""}
          </span>
        </div>
        {keys === null ? (
          <Skeleton className="h-14 w-full rounded-lg" />
        ) : keys.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-3 text-base text-muted-foreground">
            No provider keys yet — add one to enable model calls.
          </p>
        ) : (
          <div className="space-y-2">
            {keys.map((k) => (
              <div key={k.provider} className={listCard}>
                <Key className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="text-base font-medium">{k.provider}</p>
                  <p className="truncate text-xs text-muted-foreground">{k.base_url}</p>
                </div>
                <KeyDelete provider={k.provider} onChanged={reload} />
              </div>
            ))}
          </div>
        )}
        <AddKey onChanged={reload} />
      </section>

      {/* model routes */}
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className={label}>Model routes</h3>
          <Button
            size="sm"
            variant="outline"
            className="h-8 gap-1"
            onClick={() => setView({ kind: "add" })}
          >
            <Plus className="size-3.5" /> Add model
          </Button>
        </div>
        {routes === null ? (
          <div className="space-y-2">
            <Skeleton className="h-14 w-full rounded-lg" />
            <Skeleton className="h-14 w-full rounded-lg" />
          </div>
        ) : routes.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-4 py-3 text-base text-muted-foreground">
            No model routes — add one to make a model selectable in chats.
          </p>
        ) : (
          <div className="space-y-2">
            {routes.map((r) => (
              <button
                key={r.model}
                className={listCard}
                onClick={() => setView({ kind: "detail", model: r.model })}
              >
                <span
                  className={`size-2 shrink-0 rounded-full ${
                    r.enabled ? "bg-emerald-500" : "bg-muted-foreground/40"
                  }`}
                  title={r.enabled ? "enabled" : "disabled"}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="truncate text-base font-medium">{r.model}</p>
                    <span className="rounded bg-muted px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
                      {r.provider}
                    </span>
                    {r.modalities.map((m) => (
                      <span
                        key={m}
                        className="rounded bg-muted px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground"
                      >
                        {m}
                      </span>
                    ))}
                    {r.reasoning && (
                      <span className="rounded bg-muted px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
                        reasoning
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {fmtUsd(r.price_per_mtok_in_usd)} in · {fmtUsd(r.price_per_mtok_out_usd)} out
                    {r.context_window != null
                      ? ` · ${(r.context_window / 1000).toFixed(0)}k context`
                      : ""}
                    {r.quota_monthly_usd != null ? ` · cap ${fmtUsd(r.quota_monthly_usd)}/mo` : ""}
                  </p>
                </div>
                <Pencil className="size-3.5 shrink-0 text-muted-foreground/60" />
              </button>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function KeyDelete({ provider, onChanged }: { provider: string; onChanged: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!confirm) {
    return (
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0 text-muted-foreground hover:text-destructive"
        title={`Delete ${provider} key`}
        onClick={() => setConfirm(true)}
      >
        <Trash2 className="size-3.5" />
      </Button>
    );
  }
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Button
        size="sm"
        variant="destructive"
        className="h-7 px-2 text-xs"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api("DELETE", `/api/v1/admin/gateway/keys/${encodeURIComponent(provider)}`);
            onChanged();
          } finally {
            setBusy(false);
            setConfirm(false);
          }
        }}
      >
        {busy ? "…" : "Delete"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        onClick={() => setConfirm(false)}
      >
        Cancel
      </Button>
    </span>
  );
}

function AddKey({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState("openai");
  const [baseUrl, setBaseUrl] = useState("https://api.openai.com");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <Button
        size="sm"
        variant="outline"
        className="mt-2 h-8 gap-1"
        onClick={() => setOpen(true)}
      >
        <Plus className="size-3.5" /> Add provider key
      </Button>
    );
  }
  return (
    <div className="mt-2 space-y-3 rounded-lg border border-border p-4">
      <div className="grid grid-cols-[130px_1fr] items-center gap-4">
        <span className="text-xs text-muted-foreground">Provider</span>
        <Input className="h-8" value={provider} onChange={(e) => setProvider(e.target.value)} />
        <span className="text-xs text-muted-foreground">Base URL</span>
        <Input className="h-8" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        <span className="text-xs text-muted-foreground">API key</span>
        <Input
          className="h-8"
          type="password"
          value={key}
          placeholder="sk-…"
          onChange={(e) => setKey(e.target.value)}
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={!key || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await api("POST", "/api/v1/admin/gateway/keys", {
                provider,
                base_url: baseUrl,
                key,
              });
              setKey("");
              setOpen(false);
              onChanged();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Saving…" : "Save key"}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function useRouteField(model: string) {
  const [f, setF] = useState<RouteRow | null>(null);
  useEffect(() => {
    api<{ routes: RouteRow[] }>("GET", "/api/v1/admin/gateway/routes")
      .then((r) => setF(r.routes.find((x) => x.model === model) ?? null))
      .catch(() => setF(null));
  }, [model]);
  return f;
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

  const back = (
    <button className={backBtn} onClick={onBack}>
      <ArrowLeft className="size-4" /> Models
    </button>
  );

  if (r === null || draft === null) {
    return (
      <div>
        {back}
        <Skeleton className="h-40 w-full rounded-lg" />
      </div>
    );
  }
  const patch = (p: Partial<RouteRow>) => setDraft({ ...draft, ...p });

  if (mode === "edit") {
    return (
      <div>
        {back}
        <div className="mb-4 flex items-center gap-2">
          <h3 className="text-base font-semibold">Edit route</h3>
          <span className="rounded bg-muted px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
            {draft.provider}
          </span>
        </div>
        <div className="max-w-xl space-y-1">
          <div className={row}>
            <span className={label}>Model id</span>
            <Input className={field} value={draft.model} onChange={(e) => patch({ model: e.target.value })} />
          </div>
          <div className={row}>
            <span className={label}>Provider</span>
            <select
              className={`${field} appearance-none`}
              value={draft.provider}
              onChange={(e) => patch({ provider: e.target.value })}
            >
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
            </select>
          </div>
          <div className={row}>
            <span className={label}>Status</span>
            <label className="flex items-center gap-2 text-base">
              <input
                type="checkbox"
                className="size-4 accent-foreground"
                checked={draft.enabled}
                onChange={(e) => patch({ enabled: e.target.checked })}
              />
              enabled — selectable in chats
            </label>
          </div>
          <div className={row}>
            <span className={label}>Price in</span>
            <Input
              className={field}
              value={String(draft.price_per_mtok_in_usd)}
              onChange={(e) => patch({ price_per_mtok_in_usd: Number(e.target.value) || 0 })}
            />
            <span className={label}>Price out</span>
            <Input
              className={field}
              value={String(draft.price_per_mtok_out_usd)}
              onChange={(e) => patch({ price_per_mtok_out_usd: Number(e.target.value) || 0 })}
            />
          </div>
          <div className={row}>
            <span className={label}>Monthly cap</span>
            <Input
              className={field}
              value={draft.quota_monthly_usd != null ? String(draft.quota_monthly_usd) : ""}
              placeholder="unlimited"
              onChange={(e) =>
                patch({
                  quota_monthly_usd: e.target.value === "" ? null : Number(e.target.value),
                })
              }
            />
          </div>
          <div className={row}>
            <span className={label}>Context window</span>
            <Input
              className={field}
              value={draft.context_window != null ? String(draft.context_window) : ""}
              placeholder="128000"
              onChange={(e) =>
                patch({ context_window: e.target.value === "" ? null : Number(e.target.value) })
              }
            />
          </div>
          <div className={row}>
            <span className={label}>Capabilities</span>
            <div className="flex flex-wrap gap-4 text-base">
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
          </div>
        </div>
        {error && <p className="mt-3 text-base text-destructive">{error}</p>}
        <div className="mt-5 flex items-center gap-2">
          <Button
            disabled={busy}
            onClick={async () => {
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
                onChanged();
                setDraft(null);
                setMode("view");
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              } finally {
                setBusy(false);
              }
            }}
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
    );
  }

  // view: saved route as facts + explicit actions
  return (
    <div>
      {back}
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-base font-semibold">{r.model}</h3>
        <span className="rounded bg-muted px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
          {r.provider}
        </span>
        <span
          className={`size-2 rounded-full ${r.enabled ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
          title={r.enabled ? "enabled" : "disabled"}
        />
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        {r.enabled ? "Selectable in chats." : "Disabled — not selectable in chats."}
      </p>
      <div className="max-w-xl space-y-4">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className={label}>Pricing</p>
          <p className="mt-1 text-base">
            {fmtUsd(r.price_per_mtok_in_usd)} in · {fmtUsd(r.price_per_mtok_out_usd)} out
            {r.quota_monthly_usd != null ? ` · cap ${fmtUsd(r.quota_monthly_usd)}/mo` : " · no cap"}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className={label}>Context window</p>
          <p className="mt-1 text-base">
            {r.context_window != null ? `${(r.context_window / 1000).toFixed(0)}k tokens` : "provider default"}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-4">
          <p className={label}>Capabilities</p>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {r.reasoning && (
              <span className="rounded bg-muted px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
                reasoning
              </span>
            )}
            {r.modalities.length === 0 && !r.reasoning && (
              <p className="text-base text-muted-foreground">text only</p>
            )}
            {r.modalities.map((m) => (
              <span
                key={m}
                className="rounded bg-muted px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground"
              >
                {m}
              </span>
            ))}
          </div>
        </div>

        {error && <p className="text-base text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          <Button onClick={() => setMode("edit")}>
            <Pencil className="mr-1 size-3.5" /> Edit
          </Button>
          {confirmDelete ? (
            <>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api("DELETE", `/api/v1/admin/gateway/routes/${encodeURIComponent(model)}`);
                    onBack();
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Delete route
              </Button>
              <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="ghost" className="text-muted-foreground" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="mr-1 size-3.5" /> Delete
            </Button>
          )}
        </div>
      </div>
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
      <button className={backBtn} onClick={onBack}>
        <ArrowLeft className="size-4" /> Models
      </button>
      <h3 className="mb-4 text-base font-semibold">Add a model route</h3>
      <div className="max-w-xl space-y-1">
        <div className={row}>
          <span className={label}>Model id</span>
          <Input
            className={field}
            value={model}
            placeholder="e.g. GLM-5.3-Flash"
            onChange={(e) => setModel(e.target.value)}
          />
        </div>
        <div className={row}>
          <span className={label}>Provider</span>
          <select
            className={`${field} appearance-none`}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="openai">openai</option>
            <option value="anthropic">anthropic</option>
          </select>
        </div>
        <p className="pt-2 text-xs text-muted-foreground">
          The route is created enabled with zero pricing; open it from the list to set
          pricing, context window and capabilities.
        </p>
      </div>
      {error && <p className="mt-3 text-base text-destructive">{error}</p>}
      <div className="mt-5 flex gap-2">
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
              onAdded(model.trim());
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
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
  );
}
