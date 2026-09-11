//! Integrations section — port of the /admin console Integrations view into
//! the settings style. Available integrations grouped by category; configured
//! integrations get an enable toggle + JSON config editor + Save.

import { useCallback, useEffect, useState } from "react";
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

function categoryLabel(category?: string): string {
  return CATEGORY_LABELS[category ?? "other"] ?? CATEGORY_LABELS.other;
}

/** One configured integration: enable toggle + JSON config editor + Save. */
function IntegrationCard({
  name,
  initialConfig,
  enabled,
  reload,
}: {
  name: string;
  initialConfig: Record<string, unknown>;
  enabled: boolean;
  reload: () => void;
}) {
  const [text, setText] = useState(JSON.stringify(initialConfig ?? {}, null, 2));
  const [isOn, setIsOn] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (nextEnabled: boolean) => {
    setError(null);
    let config: unknown;
    try {
      config = JSON.parse(text);
    } catch {
      setError("invalid JSON — fix the config before saving");
      return;
    }
    setBusy(true);
    try {
      await api("PUT", `/api/v1/admin/integrations/${encodeURIComponent(name)}`, {
        config,
        enabled: nextEnabled,
      });
      setIsOn(nextEnabled);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <span className="font-mono text-sm font-medium">{name}</span>
        <button
          className={`rounded-full px-2 py-0.5 text-xs transition-colors ${
            isOn ? "bg-emerald-500/15 text-emerald-500" : "bg-muted text-muted-foreground"
          } disabled:opacity-50`}
          disabled={busy}
          title={isOn ? "Click to disable" : "Click to enable"}
          onClick={() => void save(!isOn)}
        >
          {isOn ? "enabled" : "disabled"}
        </button>
        <Button
          className="ml-auto"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => void save(isOn)}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
      <Textarea
        className="mt-3 min-h-24 font-mono text-xs"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <p className="mt-1 text-xs text-muted-foreground">JSON config for this integration.</p>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

export default function IntegrationsSection() {
  const [rows, setRows] = useState<IntegrationRow[] | null>(null);
  const [available, setAvailable] = useState<AvailableEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api<{ integrations: IntegrationRow[]; available: AvailableEntry[] }>(
      "GET",
      "/api/v1/admin/integrations",
    )
      .then((r) => {
        setRows(r.integrations ?? []);
        setAvailable(r.available ?? []);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(reload, [reload]);

  if (error && rows === null) {
    return (
      <p className="rounded-lg border border-destructive/40 bg-card p-3 text-sm text-destructive">
        {error}
      </p>
    );
  }

  if (rows === null) {
    return (
      <div className="space-y-3 pt-2">
        <Skeleton className="h-4 w-44" />
        <div className="flex gap-2">
          <Skeleton className="h-9 w-28 rounded-lg" />
          <Skeleton className="h-9 w-28 rounded-lg" />
        </div>
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-32 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    );
  }

  const configuredNames = new Set(rows.map((r) => r.name));

  // Group available integrations by category (missing category → "other").
  const groups = new Map<string, AvailableEntry[]>();
  for (const a of available) {
    const cat = categoryLabel(a.category);
    const list = groups.get(cat) ?? [];
    list.push(a);
    groups.set(cat, list);
  }
  const sortedCats = [...groups.keys()].sort();

  return (
    <div className="space-y-6 pt-2">
      {error && <p className="text-xs text-destructive">{error}</p>}

      <section className="space-y-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Available integrations
        </h3>
        <div className="rounded-lg border border-border bg-card p-4">
          {sortedCats.map((cat) => (
            <div key={cat} className={cat !== sortedCats[0] ? "mt-4" : undefined}>
              <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/80">
                {cat}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {groups.get(cat)!.map((a) => (
                  <div
                    key={a.name}
                    className="rounded-lg border border-border bg-background px-3 py-1.5 text-sm"
                  >
                    <span className="font-medium">{a.name}</span>
                    {configuredNames.has(a.name) && (
                      <span className="ml-2 text-xs text-emerald-500">configured</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {available.length === 0 && (
            <p className="text-sm text-muted-foreground">No integrations available.</p>
          )}
        </div>
      </section>

      <section className="space-y-3">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Configured
        </h3>
        {rows.length === 0 ? (
          <p className="rounded-lg border border-border bg-card p-4 text-sm text-muted-foreground">
            Nothing configured for this org yet.
          </p>
        ) : (
          <div className="space-y-3">
            {rows.map((r) => (
              <IntegrationCard
                key={r.name}
                name={r.name}
                initialConfig={r.config}
                enabled={r.enabled}
                reload={reload}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
