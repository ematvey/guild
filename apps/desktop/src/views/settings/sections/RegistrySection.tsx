//! RegistrySection — admin settings: a rich list screen of registry items
//! (skills / mcp / integrations) with a detail screen per item showing its
//! versions and the review action (approve / revert to draft).

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, ArrowUpRight, Package, Pencil } from "lucide-react";
import { api } from "../admin-api";
import { Button } from "@guild/ui/components/button";
import { Skeleton } from "@guild/ui/components/skeleton";

interface ItemRow {
  slug: string;
  description: string | null;
  latest_version: string | null;
  review_status: string;
}

interface VersionRow {
  version: string;
  published_at: string | null;
}

const KINDS = ["skill", "mcp", "integration"] as const;
type Kind = (typeof KINDS)[number];

const KIND_LABELS: Record<Kind, string> = {
  skill: "Skills",
  mcp: "MCP servers",
  integration: "Integrations",
};

const backBtn =
  "mb-4 flex items-center gap-1.5 text-base text-muted-foreground transition-colors hover:text-foreground";
const listCard =
  "flex w-full items-center gap-3 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-accent/40";
const label = "text-xs font-medium uppercase tracking-wide text-muted-foreground";

const reviewPill = (status: string) => (
  <span
    className={`shrink-0 rounded-full border px-1.5 py-px text-[10px] uppercase tracking-wide ${
      status === "approved"
        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
        : "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
    }`}
  >
    {status}
  </span>
);

export default function RegistrySection() {
  const [detail, setDetail] = useState<{ kind: Kind; slug: string } | null>(null);

  if (detail) {
    return (
      <ItemDetail
        kind={detail.kind}
        slug={detail.slug}
        onBack={() => setDetail(null)}
      />
    );
  }
  return <RegistryList onOpen={(kind, slug) => setDetail({ kind, slug })} />;
}

function RegistryList({ onOpen }: { onOpen: (kind: Kind, slug: string) => void }) {
  const [items, setItems] = useState<Record<Kind, ItemRow[] | null>>({
    skill: null,
    mcp: null,
    integration: null,
  });
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    for (const kind of KINDS) {
      api<{ items: ItemRow[] }>("GET", `/api/v1/registry/${kind}`)
        .then((r) => setItems((s) => ({ ...s, [kind]: r.items })))
        .catch((e) => {
          setItems((s) => ({ ...s, [kind]: [] }));
          setError(e instanceof Error ? e.message : String(e));
        });
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const total = KINDS.reduce((n, k) => n + (items[k]?.length ?? 0), 0);

  return (
    <div className="space-y-6">
      {error && <p className="text-base text-destructive">{error}</p>}
      {KINDS.map((kind) => (
        <section key={kind}>
          <div className="mb-2 flex items-center justify-between">
            <h3 className={label}>{KIND_LABELS[kind]}</h3>
            <span className="text-xs text-muted-foreground">
              {items[kind] ? `${items[kind].length} items` : ""}
            </span>
          </div>
          {items[kind] === null ? (
            <Skeleton className="h-14 w-full rounded-lg" />
          ) : items[kind]!.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border px-4 py-3 text-base text-muted-foreground">
              Nothing published under {KIND_LABELS[kind].toLowerCase()} yet — publishing
              happens through the registry API (`POST /api/v1/registry/{kind}`).
            </p>
          ) : (
            <div className="space-y-2">
              {items[kind]!.map((it) => (
                <button
                  key={it.slug}
                  className={listCard}
                  onClick={() => onOpen(kind, it.slug)}
                >
                  <Package className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <p className="truncate text-base font-medium">{it.slug}</p>
                      {it.latest_version && (
                        <span className="rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
                          v{it.latest_version}
                        </span>
                      )}
                    </div>
                    {it.description && (
                      <p className="truncate text-xs text-muted-foreground">{it.description}</p>
                    )}
                  </div>
                  {reviewPill(it.review_status)}
                  <Pencil className="size-3.5 shrink-0 text-muted-foreground/60" />
                </button>
              ))}
            </div>
          )}
        </section>
      ))}
      {total === 0 && KINDS.every((k) => items[k] !== null) && (
        <p className="text-xs text-muted-foreground">
          The registry holds installable bundles for the desktop app; entries appear here
          once published.
        </p>
      )}
    </div>
  );
}

function ItemDetail({
  kind,
  slug,
  onBack,
}: {
  kind: Kind;
  slug: string;
  onBack: () => void;
}) {
  const [item, setItem] = useState<ItemRow | null>(null);
  const [versions, setVersions] = useState<VersionRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    api<{ items: ItemRow[] }>("GET", `/api/v1/registry/${kind}`)
      .then((r) => setItem(r.items.find((x) => x.slug === slug) ?? null))
      .catch(() => setItem(null));
    api<{ versions: VersionRow[] }>("GET", `/api/v1/registry/${kind}/${encodeURIComponent(slug)}`)
      .then((r) => setVersions(r.versions))
      .catch((e) => {
        setVersions([]);
        setError(e instanceof Error ? e.message : String(e));
      });
  }, [kind, slug]);

  useEffect(() => {
    reload();
  }, [reload]);

  return (
    <div>
      <button className={backBtn} onClick={onBack}>
        <ArrowLeft className="size-4" /> Registry
      </button>
      <div className="mb-1 flex items-center gap-2">
        <h3 className="text-base font-semibold">{slug}</h3>
        <span className="rounded bg-muted px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground">
          {kind}
        </span>
        {item && reviewPill(item.review_status)}
      </div>
      {item?.description && (
        <p className="mb-4 max-w-xl text-base text-muted-foreground">{item.description}</p>
      )}

      <div className="max-w-xl space-y-4">
        <section>
          <h4 className="mb-2">{label}Versions</h4>
          {versions === null ? (
            <Skeleton className="h-20 w-full rounded-lg" />
          ) : versions.length === 0 ? (
            <p className="text-base text-muted-foreground">No versions published.</p>
          ) : (
            <div className="space-y-2">
              {versions.map((v) => (
                <div
                  key={v.version}
                  className="flex items-center justify-between rounded-lg border border-border px-4 py-2.5"
                >
                  <span className="font-mono text-base">v{v.version}</span>
                  <span className="text-xs text-muted-foreground">
                    {v.published_at ? new Date(v.published_at).toLocaleString() : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <h4 className="mb-2">{label}Review</h4>
          <p className="mb-2 text-xs text-muted-foreground">
            Only approved items are installable from the desktop app.
          </p>
          {error && <p className="mb-2 text-base text-destructive">{error}</p>}
          <div className="flex gap-2">
            {item?.review_status !== "approved" && (
              <Button
                size="sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await api("POST", `/api/v1/registry/${kind}/${encodeURIComponent(slug)}/review`, {
                      status: "approved",
                    });
                    reload();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Approve
              </Button>
            )}
            {item?.review_status === "approved" && (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError(null);
                  try {
                    await api("POST", `/api/v1/registry/${kind}/${encodeURIComponent(slug)}/review`, {
                      status: "draft",
                    });
                    reload();
                  } catch (e) {
                    setError(e instanceof Error ? e.message : String(e));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Revert to draft
              </Button>
            )}
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <ArrowUpRight className="size-3.5" /> publishing stays API-side
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}
