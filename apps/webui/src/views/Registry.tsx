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
  const [kind, setKind] = useState<(typeof KINDS)[number]>("skill");
  const [items, setItems] = useState<ItemRow[]>([]);
  const [versions, setVersions] = useState<VersionRow[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api<{ items: ItemRow[] }>("GET", `/api/v1/registry/${kind}`)
      .then((r) => setItems(r.items))
      .catch((e: unknown) => setError(String(e instanceof Error ? e.message : e)));
  }, [kind]);

  useEffect(reload, [reload]);

  const openItem = async (slug: string) => {
    setSelected(slug);
    setVersions([]);
    try {
      const r = await api<{ versions: VersionRow[] }>("GET", `/api/v1/registry/${kind}/${slug}`);
      setVersions(r.versions);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

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
            className={`rounded px-3 py-1 text-sm ${kind === k ? "bg-neutral-700" : "bg-neutral-900 text-neutral-500 hover:text-neutral-300"}`}
            onClick={() => {
              setKind(k);
              setSelected(null);
            }}
          >
            {k}
          </button>
        ))}
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-neutral-500">
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
            <tr key={it.slug} className="border-t border-neutral-800">
              <td className="py-2 font-mono text-xs">{it.slug}</td>
              <td className="text-neutral-400">{it.description}</td>
              <td>{it.latest_version}</td>
              <td>
                <span className={it.review_status === "approved" ? "text-green-400" : "text-amber-400"}>
                  {it.review_status}
                </span>
              </td>
              <td className="space-x-3 text-right text-xs">
                <button className="text-neutral-400 hover:underline" onClick={() => openItem(it.slug)}>
                  versions
                </button>
                {it.review_status === "draft" ? (
                  <button className="text-green-400 hover:underline" onClick={() => review(it.slug, "approved")}>
                    approve
                  </button>
                ) : (
                  <button className="text-amber-400 hover:underline" onClick={() => review(it.slug, "draft")}>
                    revert to draft
                  </button>
                )}
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td colSpan={5} className="py-4 text-neutral-500">
                nothing published under {kind}
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {selected && (
        <div className="rounded-lg border border-neutral-800 p-4">
          <h3 className="mb-2 text-sm font-medium">{selected} — versions</h3>
          <ul className="space-y-1 text-sm text-neutral-400">
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
