import { useCallback, useEffect, useState } from "react";
import { api } from "../api";

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

export default function Registry() {
  // URL-driven sub-navigation: #/registry/<kind>[/<slug>] — back/forward and
  // deep links land on the exact kind filter and item drill-down.
  const parseHash = () => {
    const segs = window.location.hash
      .replace(/^#\/?/, "")
      .split("/")
      .filter(Boolean)
      .map(decodeURIComponent);
    const kind = (KINDS as readonly string[]).includes(segs[1])
      ? (segs[1] as (typeof KINDS)[number])
      : "skill";
    return { kind, slug: segs[2] ?? null };
  };
  const [loc, setLoc] = useState(parseHash);
  useEffect(() => {
    const onHash = () => setLoc(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const { kind, slug: selected } = loc;

  const navigate = (kind: string, slug: string | null) => {
    const next = `#/registry/${kind}${slug ? `/${encodeURIComponent(slug)}` : ""}`;
    if (window.location.hash !== next) window.location.hash = next;
  };

  const [items, setItems] = useState<ItemRow[]>([]);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api<{ items: ItemRow[] }>("GET", `/api/v1/registry/${kind}`)
      .then((r) => setItems(r.items))
      .catch((e: unknown) => setError(String(e instanceof Error ? e.message : e)));
  }, [kind]);

  useEffect(reload, [reload]);

  // Version listing follows the URL-driven selection.
  useEffect(() => {
    if (!selected) {
      setVersions([]);
      return;
    }
    setVersions([]);
    let dead = false;
    api<{ versions: VersionRow[] }>("GET", `/api/v1/registry/${kind}/${selected}`)
      .then((r) => !dead && setVersions(r.versions))
      .catch((e: unknown) => !dead && setError(String(e instanceof Error ? e.message : e)));
    return () => {
      dead = true;
    };
  }, [kind, selected]);

  const review = async (slug: string, status: "approved" | "draft") => {
    try {
      await api("POST", `/api/v1/registry/${kind}/${slug}/review`, { status });
      reload();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  return (
    <div className="space-y-6 p-6">
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2">
        {KINDS.map((k) => (
          <button
            key={k}
            className={`rounded px-3 py-1 text-sm ${kind === k ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground"}`}
            onClick={() => navigate(k, null)}
          >
            {k}
          </button>
        ))}
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="py-2">slug</th>
            <th>description</th>
            <th>latest</th>
            <th>status</th>
            <th className="text-right">actions</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.slug} className="border-t border-border">
              <td className="py-2 font-mono text-xs">{it.slug}</td>
              <td className="text-muted-foreground">{it.description}</td>
              <td>{it.latest_version}</td>
              <td>
                <span className={it.review_status === "approved" ? "text-green-400" : "text-amber-400"}>
                  {it.review_status}
                </span>
              </td>
              <td className="space-x-3 text-right text-xs">
                <button className="text-muted-foreground hover:underline" onClick={() => navigate(kind, it.slug)}>
                  versions
                </button>
                {it.review_status === "draft" ? (
                  <button className="text-emerald-600 dark:text-emerald-400 hover:underline" onClick={() => review(it.slug, "approved")}>
                    approve
                  </button>
                ) : (
                  <button className="text-amber-600 dark:text-amber-400 hover:underline" onClick={() => review(it.slug, "draft")}>
                    revert to draft
                  </button>
                )}
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={5} className="py-4 text-muted-foreground">
                nothing published under {kind}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {selected && (
        <div className="rounded-lg border border-border p-4">
          <h3 className="mb-2 flex items-center justify-between text-sm font-medium">
            <span>{selected} — versions</span>
            <button className="text-xs text-muted-foreground hover:underline" onClick={() => navigate(kind, null)}>
              close
            </button>
          </h3>
          <ul className="space-y-1 text-sm text-muted-foreground">
            {versions.map((v) => (
              <li key={v.version} className="font-mono text-xs">
                {v.version} — {new Date(v.published_at).toLocaleString()}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
