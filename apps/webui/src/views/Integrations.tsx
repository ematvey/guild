import { useCallback, useEffect, useState } from "react";
import { api } from "../api";
import { Button } from "@guild/ui/components/button";
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
  search: "Search providers",
  fetch: "Fetch providers",
  other: "Other",
};

function categoryLabel(category?: string): string {
  return CATEGORY_LABELS[category ?? "other"] ?? CATEGORY_LABELS.other;
}

/** One configured (or newly configured) integration: enable toggle + JSON config editor. */
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
      setError("invalid JSON");
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
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">{name}</span>
        <button
          className={`rounded-full px-2 py-0.5 text-xs ${
            isOn ? "bg-emerald-500/15 text-emerald-400" : "bg-muted text-muted-foreground"
          }`}
          disabled={busy}
          title={isOn ? "Click to disable" : "Click to enable"}
          onClick={() => void save(!isOn)}
        >
          {isOn ? "enabled" : "disabled"}
        </button>
        <Button className="ml-auto" variant="outline" size="sm" disabled={busy} onClick={() => void save(isOn)}>
          Save
        </Button>
      </div>
      <Textarea
        className="mt-3 min-h-24 font-mono text-xs"
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
    </div>
  );
}

export default function Integrations() {
  const [rows, setRows] = useState<IntegrationRow[]>([]);
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
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  useEffect(reload, [reload]);

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
    <div className="space-y-6 p-6">
      {error && <p className="text-sm text-red-400">{error}</p>}

      <section>
        <h2 className="text-sm font-medium text-muted-foreground">Available integrations</h2>
        <div className="mt-3 space-y-4">
          {sortedCats.map((cat) => (
            <div key={cat}>
              <h3 className="text-xs uppercase tracking-wide text-muted-foreground">{cat}</h3>
              <div className="mt-2 flex flex-wrap gap-2">
                {groups.get(cat)!.map((a) => (
                  <div key={a.name} className="rounded-lg border border-border bg-card px-3 py-2 text-sm">
                    <span className="font-medium">{a.name}</span>
                    {configuredNames.has(a.name) && (
                      <span className="ml-2 text-xs text-emerald-400">configured</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
          {available.length === 0 && <p className="text-sm text-muted-foreground">No integrations available.</p>}
        </div>
      </section>

      <section>
        <h2 className="text-sm font-medium text-muted-foreground">Configured</h2>
        <div className="mt-3 grid gap-3 lg:grid-cols-2">
          {rows.map((r) => (
            <IntegrationCard
              key={r.name}
              name={r.name}
              initialConfig={r.config}
              enabled={r.enabled}
              reload={reload}
            />
          ))}
          {rows.length === 0 && (
            <p className="text-sm text-muted-foreground">Nothing configured for this org yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}
