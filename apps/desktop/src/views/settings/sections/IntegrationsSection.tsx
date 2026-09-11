//! IntegrationsSection — admin settings: a rich list screen of available and
//! configured integrations; clicking one opens a separate detail screen with
//! the enable toggle, JSON config editor, save and delete (list → drill-in →
//! back, mirroring established settings apps).

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowUpRight, Pencil, Plus, Trash2, Webhook } from "lucide-react";
import { api } from "../admin-api";
import { Button } from "@guild/ui/components/button";
import { Skeleton } from "@guild/ui/components/skeleton";
import { Textarea } from "@guild/ui/components/textarea";

interface IntegrationRow {
  org_id: string;
  name: string;
  config: Record<string, unknown>;
  enabled: boolean;
}

interface AvailableEntry {
  name: string;
  category?: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  fetch: "Fetch providers",
  search: "Search providers",
  other: "Other",
};

const categoryLabel = (c?: string) => CATEGORY_LABELS[c ?? "other"] ?? CATEGORY_LABELS.other;

const backBtn =
  "mb-4 flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground";
const listCard =
  "flex w-full items-center gap-3 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-accent/40";
const label = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

export default function IntegrationsSection() {
  const [rows, setRows] = useState<IntegrationRow[] | null>(null);
  const [available, setAvailable] = useState<AvailableEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);

  const reload = useCallback(() => {
    api<{ integrations: IntegrationRow[]; available: AvailableEntry[] }>(
      "GET",
      "/api/v1/admin/integrations",
    )
      .then((r) => {
        setRows(r.integrations);
        setAvailable(r.available);
      })
      .catch((e) => {
        setRows([]);
        setAvailable([]);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  if (detail !== null) {
    const configured = rows?.find((r) => r.name === detail);
    return (
      <IntegrationDetail
        name={detail}
        category={available?.find((a) => a.name === detail)?.category}
        initialConfig={configured?.config ?? null}
        initialEnabled={configured?.enabled ?? false}
        onChanged={reload}
        onBack={() => {
          reload();
          setDetail(null);
        }}
      />
    );
  }

  const availableNames = new Set((available ?? []).map((a) => a.name));

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-destructive">{error}</p>}
      {rows === null || available === null ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full rounded-lg" />
          <Skeleton className="h-14 w-full rounded-lg" />
        </div>
      ) : (
        (["fetch", "search", "other"] as const).map((cat) => {
          const inCat = available.filter((a) => (a.category ?? "other") === cat);
          if (inCat.length === 0) return null;
          return (
            <section key={cat}>
              <div className="mb-2 flex items-center justify-between">
                <h3 className={label}>{categoryLabel(cat)}</h3>
                <span className="text-xs text-muted-foreground">
                  {inCat.filter((a) => rows.some((r) => r.name === a.name && r.enabled)).length}{" "}
                  enabled
                </span>
              </div>
              <div className="space-y-2">
                {inCat.map((a) => {
                  const cfg = rows.find((r) => r.name === a.name);
                  return (
                    <button
                      key={a.name}
                      className={listCard}
                      onClick={() => setDetail(a.name)}
                    >
                      <Webhook className="size-4 shrink-0 text-muted-foreground" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{a.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {!cfg
                            ? "not configured"
                            : cfg.enabled
                              ? "enabled"
                              : "configured, disabled"}
                        </p>
                      </div>
                      {cfg && (
                        <span
                          className={`size-2 shrink-0 rounded-full ${
                            cfg.enabled ? "bg-emerald-500" : "bg-muted-foreground/40"
                          }`}
                        />
                      )}
                      <Pencil className="size-3.5 shrink-0 text-muted-foreground/60" />
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })
      )}
      {availableNames.size === 0 && rows !== null && (
        <p className="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground">
          No integrations are available in this build.
        </p>
      )}
    </div>
  );
}

function IntegrationDetail({
  name,
  category,
  initialConfig,
  initialEnabled,
  onChanged,
  onBack,
}: {
  name: string;
  category?: string;
  initialConfig: Record<string, unknown> | null;
  initialEnabled: boolean;
  onChanged: () => void;
  onBack: () => void;
}) {
  const configured = initialConfig !== null;
  const [enabled, setEnabled] = useState(initialEnabled);
  const [text, setText] = useState(
    configured ? JSON.stringify(initialConfig, null, 2) : "{\n  \n}",
  );
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div>
      <button className={backBtn} onClick={onBack}>
        <ArrowLeft className="size-4" /> Integrations
      </button>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-base font-semibold">{name}</h3>
        <span className="rounded bg-muted px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
          {categoryLabel(category)}
        </span>
      </div>
      <p className="mb-4 text-xs text-muted-foreground">
        {configured
          ? "Configured — tools from this integration join the chat loop while enabled."
          : "Not configured yet — save a config below to enable it."}
      </p>

      <div className="max-w-xl space-y-4">
        <div className="flex items-center gap-3 rounded-lg border border-border px-4 py-3">
          <label className="flex flex-1 items-center gap-3 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-foreground"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              disabled={!configured}
            />
            <span>
              Enabled
              <span className="block text-xs text-muted-foreground">
                Disabled integrations keep their config but contribute no tools.
              </span>
            </span>
          </label>
        </div>

        <div>
          <p className="mb-1.5 flex items-center gap-2">
            <span className={label}>Config (JSON)</span>
            {!configured && (
              <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground/60">
                <Plus className="size-3" /> new
              </span>
            )}
          </p>
          <Textarea
            className="min-h-40 font-mono text-xs"
            spellCheck={false}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex items-center gap-2">
          <Button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const cfg = JSON.parse(text) as Record<string, unknown>;
                await api("PUT", `/api/v1/admin/integrations/${encodeURIComponent(name)}`, {
                  config: cfg,
                  enabled,
                });
                setSaved(true);
                onChanged();
                setTimeout(() => setSaved(false), 2000);
              } catch (e) {
                setError(
                  e instanceof SyntaxError
                    ? `config is not valid JSON: ${e.message}`
                    : e instanceof Error
                      ? e.message
                      : String(e),
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : saved ? "Saved" : "Save"}
          </Button>
          {configured &&
            (confirmDelete ? (
              <>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await api(
                        "DELETE",
                        `/api/v1/admin/integrations/${encodeURIComponent(name)}`,
                      );
                      onBack();
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Remove configuration
                </Button>
                <Button variant="ghost" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </Button>
              </>
            ) : (
              <Button
                variant="ghost"
                className="text-muted-foreground"
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 className="mr-1 size-3.5" /> Remove
              </Button>
            ))}
          {!configured && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <ArrowUpRight className="size-3.5" /> saving creates the configuration
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
