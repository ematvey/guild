//! ModelsSection — admin settings section (port of the /admin Gateway view):
//! provider API keys and model routes (pricing, quota, capabilities). The
//! admin API only exposes the list of enabled model names, so route rows are
//! seeded with the model id and the editable fields start blank until saved.

import { useCallback, useEffect, useState } from "react";
import { api } from "../admin-api";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";

interface RouteFields {
  model: string;
  provider: string;
  enabled: boolean;
  price_in: string;
  price_out: string;
  quota_monthly_usd: string;
  reasoning: boolean;
  context_window: string;
  modalities: string[];
}

const blankRoute = (model = ""): RouteFields => ({
  model,
  provider: "openai",
  enabled: true,
  price_in: "",
  price_out: "",
  quota_monthly_usd: "",
  reasoning: false,
  context_window: "",
  modalities: [],
});

const card = "rounded-lg border border-border bg-card";
const cardHeader = "border-b border-border px-4 py-3";
const cardTitle = "text-xs font-medium uppercase tracking-wide text-muted-foreground";
const cellInput = "h-8 rounded-md border border-input bg-background px-2 text-xs";

export default function ModelsSection() {
  const [routes, setRoutes] = useState<RouteFields[] | null>(null);
  const [newModel, setNewModel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savingIdx, setSavingIdx] = useState<number | null>(null);
  const [savedIdx, setSavedIdx] = useState<number | null>(null);

  // provider key form
  const [keyProvider, setKeyProvider] = useState("openai");
  const [keyBaseUrl, setKeyBaseUrl] = useState("https://api.openai.com");
  const [keyValue, setKeyValue] = useState("");
  const [keySaving, setKeySaving] = useState(false);
  const [keySaved, setKeySaved] = useState(false);

  const reload = useCallback(() => {
    setError(null);
    // Full route rows (no secrets) — prefilled editing; fallback to bare
    // model names when the admin GET is unavailable.
    api<
        { routes: { model: string; provider: string; enabled: boolean; price_per_mtok_in_usd: number; price_per_mtok_out_usd: number; quota_monthly_usd: number | null; reasoning: boolean; context_window: number | null; modalities: string[] }[] }
      >("GET", "/api/v1/admin/gateway/routes")
      .then((r) =>
        setRoutes(
          r.routes.map((row) => ({
            model: row.model,
            provider: row.provider,
            enabled: row.enabled,
            price_in: String(row.price_per_mtok_in_usd ?? ""),
            price_out: String(row.price_per_mtok_out_usd ?? ""),
            quota_monthly_usd: row.quota_monthly_usd != null ? String(row.quota_monthly_usd) : "",
            reasoning: row.reasoning,
            context_window: row.context_window != null ? String(row.context_window) : "",
            modalities: row.modalities ?? [],
          })),
        ),
      )
      .catch(() =>
        api<{ models: string[] }>("GET", "/api/v1/gateway/models")
          .then((r) => setRoutes(r.models.map((m) => blankRoute(m))))
          .catch((e) => {
            setRoutes([]);
            setError(e instanceof Error ? e.message : String(e));
          }),
      );
  }, []);

  useEffect(reload, [reload]);

  const patchRoute = (idx: number, patch: Partial<RouteFields>) => {
    setRoutes((rs) => rs?.map((r, i) => (i === idx ? { ...r, ...patch } : r)) ?? rs);
    setSavedIdx(null);
  };

  const saveKey = async () => {
    if (!keyValue || keySaving) return;
    setError(null);
    setKeySaved(false);
    setKeySaving(true);
    try {
      await api("POST", "/api/v1/admin/gateway/keys", {
        provider: keyProvider,
        base_url: keyBaseUrl,
        key: keyValue,
      });
      setKeyValue("");
      setKeySaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setKeySaving(false);
    }
  };

  const saveRoute = async (r: RouteFields, idx: number) => {
    if (!r.model || !r.price_in || !r.price_out || savingIdx !== null) return;
    setError(null);
    setSavedIdx(null);
    setSavingIdx(idx);
    try {
      await api("PUT", "/api/v1/admin/gateway/routes", {
        model: r.model,
        provider: r.provider,
        enabled: r.enabled,
        price_in: Number(r.price_in),
        price_out: Number(r.price_out),
        ...(r.quota_monthly_usd !== ""
          ? { quota_monthly_usd: Number(r.quota_monthly_usd) }
          : {}),
        reasoning: r.reasoning,
        ...(r.context_window !== "" ? { context_window: Number(r.context_window) } : {}),
        modalities: r.modalities,
      });
      setSavedIdx(idx);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingIdx(null);
    }
  };

  return (
    <div className="space-y-4 pt-2">
      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* provider keys */}
      <div className={card}>
        <div className={cardHeader}>
          <p className={cardTitle}>Provider keys</p>
        </div>
        <div className="space-y-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={keyProvider}
              onChange={(e) => setKeyProvider(e.target.value)}
            >
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
            </select>
            <Input
              className="w-64"
              placeholder="base url"
              value={keyBaseUrl}
              onChange={(e) => setKeyBaseUrl(e.target.value)}
            />
            <Input
              className="w-64"
              placeholder="api key"
              type="password"
              value={keyValue}
              onChange={(e) => setKeyValue(e.target.value)}
            />
            <Button onClick={saveKey} disabled={!keyValue || keySaving}>
              {keySaving ? "Saving…" : "Save key"}
            </Button>
          </div>
          <div className="flex items-center gap-2">
            <p className="text-xs text-muted-foreground">
              Keys are stored encrypted and never sent to clients.
            </p>
            {keySaved && !keyValue && (
              <p className="text-xs text-muted-foreground">Key saved.</p>
            )}
          </div>
        </div>
      </div>

      {/* model routes */}
      <div className={card}>
        <div className={cardHeader}>
          <p className={cardTitle}>Model routes</p>
        </div>
        {routes === null ? (
          <div className="space-y-2 p-4">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-9 w-full animate-pulse rounded-md bg-accent" />
            ))}
          </div>
        ) : (
          <div className="p-4">
            <div className="space-y-2">
              {routes.map((r, idx) => (
                <div
                  key={r.model}
                  className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-lg border border-border/60 bg-background p-2"
                >
                  <input
                    className={`${cellInput} w-44 font-mono`}
                    value={r.model}
                    placeholder="model id"
                    onChange={(e) => patchRoute(idx, { model: e.target.value })}
                  />
                  <select
                    className={`${cellInput} w-24`}
                    value={r.provider}
                    onChange={(e) => patchRoute(idx, { provider: e.target.value })}
                  >
                    <option value="openai">openai</option>
                    <option value="anthropic">anthropic</option>
                  </select>
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-foreground"
                      checked={r.enabled}
                      onChange={(e) => patchRoute(idx, { enabled: e.target.checked })}
                    />
                    enabled
                  </label>
                  <input
                    className={`${cellInput} w-24`}
                    placeholder="price in $/Mtok"
                    value={r.price_in}
                    onChange={(e) => patchRoute(idx, { price_in: e.target.value })}
                  />
                  <input
                    className={`${cellInput} w-24`}
                    placeholder="price out $/Mtok"
                    value={r.price_out}
                    onChange={(e) => patchRoute(idx, { price_out: e.target.value })}
                  />
                  <input
                    className={`${cellInput} w-24`}
                    placeholder="quota $/mo"
                    value={r.quota_monthly_usd}
                    onChange={(e) => patchRoute(idx, { quota_monthly_usd: e.target.value })}
                  />
                  <label className="flex items-center gap-1 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-foreground"
                      checked={r.reasoning}
                      onChange={(e) => patchRoute(idx, { reasoning: e.target.checked })}
                    />
                    reasoning
                  </label>
                  {(["image", "audio", "video"] as const).map((m) => (
                    <label
                      key={m}
                      className="flex items-center gap-1 text-xs text-muted-foreground"
                      title={`Native ${m} input — attachments of this modality are passed to the model`}
                    >
                      <input
                        type="checkbox"
                        className="size-3.5 accent-foreground"
                        checked={r.modalities.includes(m)}
                        onChange={(e) =>
                          patchRoute(idx, {
                            modalities: e.target.checked
                              ? [...r.modalities, m]
                              : r.modalities.filter((x) => x !== m),
                          })
                        }
                      />
                      {m}
                    </label>
                  ))}
                  <input
                    className={`${cellInput} w-24`}
                    placeholder="ctx window"
                    value={r.context_window}
                    onChange={(e) => patchRoute(idx, { context_window: e.target.value })}
                  />
                  <div className="ml-auto flex items-center gap-2">
                    {savedIdx === idx && (
                      <span className="text-xs text-muted-foreground">saved</span>
                    )}
                    <Button
                      size="sm"
                      onClick={() => saveRoute(r, idx)}
                      disabled={!r.model || !r.price_in || !r.price_out || savingIdx !== null}
                    >
                      {savingIdx === idx ? "Saving…" : "Save"}
                    </Button>
                  </div>
                </div>
              ))}
              {routes.length === 0 && (
                <p className="text-sm text-muted-foreground">No routes yet — add one below.</p>
              )}
            </div>

            {/* add route */}
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-3">
              <p className="text-xs text-muted-foreground">Add route:</p>
              <Input
                className="w-44 font-mono"
                placeholder="model id"
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!newModel}
                onClick={() => {
                  setRoutes((rs) => [blankRoute(newModel), ...(rs ?? [])]);
                  setNewModel("");
                }}
              >
                Add route
              </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Prices are USD per million tokens. Quota caps monthly spend per model (blank = no
              cap). Context window is in tokens.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
