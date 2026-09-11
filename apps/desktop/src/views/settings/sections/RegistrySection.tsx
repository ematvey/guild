//! Registry section — port of the /admin console Registry view into the
//! settings style: bundle list per kind, versions drill-down, review actions.
//! (The console view has no upload UI; publishing stays API/CLI-side.)

import { useCallback, useEffect, useState } from "react";
import { api } from "../admin-api";
import { Skeleton } from "@guild/ui/components/skeleton";

interface ItemRow {
  slug: string;
  description: string;
  latest_version: string | null;
  review_status: string;
}

interface VersionRow {
  version: string;
  published_at: string;
}

const KINDS = ["skill", "mcp", "integration"] as const;

export default function RegistrySection() {
  const [kind, setKind] = useState<(typeof KINDS)[number]>("skill");
  const [items, setItems] = useState<ItemRow[] | null>(null);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setItems(null);
    api<{ items: ItemRow[] }>("GET", `/api/v1/registry/${kind}`)
      .then((r) => {
        setItems(r.items ?? []);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [kind]);

  useEffect(reload, [reload]);

  const openItem = async (slug: string) => {
    setSelected(slug);
    setVersions([]);
    try {
      const r = await api<{ versions: VersionRow[] }>("GET", `/api/v1/registry/${kind}/${slug}`);
      setVersions(r.versions ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const review = async (slug: string, status: "approved" | "draft") => {
    setError(null);
    try {
      await api("POST", `/api/v1/registry/${kind}/${slug}/review`, { status });
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-4 pt-2">
      {/* kind switcher */}
      <div className="flex gap-2">
        {KINDS.map((k) => (
          <button
            key={k}
            className={`rounded-lg border px-3 py-1.5 text-sm capitalize transition-colors ${
              kind === k
                ? "border-foreground/40 bg-accent text-foreground"
                : "border-border bg-card text-muted-foreground hover:bg-accent/50"
            }`}
            onClick={() => {
              setKind(k);
              setSelected(null);
            }}
          >
            {k}
          </button>
        ))}
      </div>

      {error && (
        <p className="rounded-lg border border-destructive/40 bg-card p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {/* bundles list */}
      {items === null && !error ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-2/3 rounded-lg" />
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card">
          {items!.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">
              Nothing published under {kind} yet.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr className="border-b border-border">
                  <th className="px-4 py-2 font-medium">Slug</th>
                  <th className="px-4 py-2 font-medium">Description</th>
                  <th className="px-4 py-2 font-medium">Latest</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {items!.map((it) => (
                  <tr key={it.slug} className="border-b border-border/60 last:border-b-0">
                    <td className="px-4 py-2 font-mono text-xs">{it.slug}</td>
                    <td className="max-w-48 truncate px-4 py-2 text-muted-foreground" title={it.description}>
                      {it.description}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs">{it.latest_version ?? "—"}</td>
                    <td className="px-4 py-2">
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs ${
                          it.review_status === "approved"
                            ? "bg-emerald-500/15 text-emerald-500"
                            : "bg-amber-500/15 text-amber-500"
                        }`}
                      >
                        {it.review_status}
                      </span>
                    </td>
                    <td className="space-x-3 px-4 py-2 text-right text-xs">
                      <button
                        className="text-muted-foreground underline-offset-2 hover:underline"
                        onClick={() => void openItem(it.slug)}
                      >
                        versions
                      </button>
                      {it.review_status === "draft" ? (
                        <button
                          className="text-emerald-500 underline-offset-2 hover:underline"
                          onClick={() => void review(it.slug, "approved")}
                        >
                          approve
                        </button>
                      ) : (
                        <button
                          className="text-amber-500 underline-offset-2 hover:underline"
                          onClick={() => void review(it.slug, "draft")}
                        >
                          revert to draft
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* versions drill-down */}
      {selected && (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium">
            <span className="font-mono">{selected}</span> — versions
          </p>
          <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
            {versions.map((v) => (
              <li key={v.version} className="font-mono text-xs">
                {v.version} — {new Date(v.published_at).toLocaleString()}
              </li>
            ))}
            {versions.length === 0 && <li className="text-xs">loading…</li>}
          </ul>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        Bundles are published via the API (tar.gz per kind: skill, mcp, integration). Members can
        only install approved items.
      </p>
    </div>
  );
}
