//! RegistrySection — registry items (skills / mcp / integrations) in one
//! data table with a kind column; the item detail page shows description,
//! versions and the review action (approve / revert to draft).

import { useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import type { SectionDetailProps } from "../section-nav";
import { useCachedGet } from "../use-cached-api";
import { ArrowUpRight, Package } from "lucide-react";
import { toast } from "sonner";
import { api } from "../admin-api";
import { Button } from "@guild/ui/components/button";
import { DataTable } from "@guild/ui/components/data-table";
import { Badge } from "@guild/ui/components/badge";
import { Skeleton } from "@guild/ui/components/skeleton";
import { PageHeader } from "../components/page-header";
import { FactCard, FactGrid } from "../components/fact-card";

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
  skill: "Skill",
  mcp: "MCP server",
  integration: "Integration",
};

function ReviewBadge({ status }: { status: string }) {
  return (
    <Badge
      variant="outline"
      className={
        status === "approved"
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
          : "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
      }
    >
      {status}
    </Badge>
  );
}

export default function RegistrySection({
  detail = null,
  onDetailChange,
}: SectionDetailProps) {
  const [kind, slug] = (detail ?? "").split("/");
  if (detail && (KINDS as readonly string[]).includes(kind) && slug) {
    return (
      <ItemDetail
        kind={kind as Kind}
        slug={slug}
        onBack={() => onDetailChange(null)}
      />
    );
  }
  return <RegistryList onOpen={(k, s) => onDetailChange(`${k}/${s}`)} />;
}

function RegistryList({ onOpen }: { onOpen: (kind: Kind, slug: string) => void }) {
  const skill = useCachedGet<{ items: ItemRow[] }>("/api/v1/registry/skill");
  const mcp = useCachedGet<{ items: ItemRow[] }>("/api/v1/registry/mcp");
  const integration = useCachedGet<{ items: ItemRow[] }>(
    "/api/v1/registry/integration",
  );
  const items: Record<Kind, ItemRow[] | null> = {
    skill: skill.data?.items ?? null,
    mcp: mcp.data?.items ?? null,
    integration: integration.data?.items ?? null,
  };
  const error = skill.error ?? mcp.error ?? integration.error;
  // null while any kind is still loading so the table shows skeletons, not a
  // premature "empty" state.
  const data = KINDS.every((k) => items[k] !== null)
    ? KINDS.flatMap((k) => (items[k] ?? []).map((it) => ({ ...it, kind: k as Kind })))
    : null;

  const columns = useMemo<ColumnDef<ItemRow & { kind: Kind }, any>[]>(
    () => [
      {
        accessorKey: "slug",
        header: "Slug",
        cell: ({ row }) => (
          <div className="flex min-w-0 items-center gap-3">
            <Package className="size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <p className="truncate font-medium">{row.original.slug}</p>
              {row.original.description && (
                <p className="truncate text-xs text-muted-foreground">
                  {row.original.description}
                </p>
              )}
            </div>
          </div>
        ),
      },
      {
        accessorKey: "kind",
        header: "Kind",
        cell: ({ row }) => <Badge variant="secondary">{KIND_LABELS[row.original.kind]}</Badge>,
      },
      {
        accessorKey: "latest_version",
        header: "Version",
        cell: ({ row }) => (
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {row.original.latest_version ? `v${row.original.latest_version}` : "—"}
          </span>
        ),
      },
      {
        accessorKey: "review_status",
        header: "Review",
        cell: ({ row }) => <ReviewBadge status={row.original.review_status} />,
      },
    ],
    [],
  );

  return (
    <div>
      <PageHeader
        title="Registry"
        description="Installable bundles for the desktop app; entries appear here once published through the registry API."
      />
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <DataTable
        columns={columns}
        data={data}
        search={(r) => `${r.slug} ${r.kind} ${r.description ?? ""} ${r.review_status}`}
        searchPlaceholder="Search registry…"
        onRowClick={(r) => onOpen(r.kind, r.slug)}
        pageSize={15}
      />
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const itemsRes = useCachedGet<{ items: ItemRow[] }>(`/api/v1/registry/${kind}`);
  const versionsRes = useCachedGet<{ versions: VersionRow[] }>(
    `/api/v1/registry/${kind}/${encodeURIComponent(slug)}`,
  );
  const item = itemsRes.data?.items.find((x) => x.slug === slug) ?? null;
  const versions = versionsRes.data?.versions ?? null;

  const reload = () => {
    itemsRes.reload();
    versionsRes.reload();
  };

  const review = async (status: "approved" | "draft") => {
    setBusy(true);
    setError(null);
    try {
      await api("POST", `/api/v1/registry/${kind}/${encodeURIComponent(slug)}/review`, {
        status,
      });
      toast.success(status === "approved" ? "Approved" : "Reverted to draft", {
        description: slug,
      });
      reload();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error("Review failed", { description: msg });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title={slug}
        description={item?.description ?? undefined}
        back={{ label: "Registry", onClick: onBack }}
        actions={
          item?.review_status !== "approved" ? (
            <Button size="sm" disabled={busy} onClick={() => review("approved")}>
              Approve
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => review("draft")}
            >
              Revert to draft
            </Button>
          )
        }
      />

      <FactGrid>
        <FactCard label="Kind">
          <Badge variant="secondary">{KIND_LABELS[kind]}</Badge>
        </FactCard>
        <FactCard label="Review status">
          {item ? <ReviewBadge status={item.review_status} /> : "…"}
        </FactCard>
        <FactCard label="Latest version">
          <span className="font-mono">
            {item?.latest_version ? `v${item.latest_version}` : "—"}
          </span>
        </FactCard>
        <FactCard label="Installability">
          {item?.review_status === "approved"
            ? "Installable from the desktop app"
            : "Not installable until approved"}
        </FactCard>
      </FactGrid>

      <div className="rounded-lg border border-border bg-card p-4">
        <p className="text-sm font-medium">Versions</p>
        {versions === null ? (
          <Skeleton className="mt-3 h-12 w-full rounded-md" />
        ) : versions.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No versions published.</p>
        ) : (
          <ul className="mt-2 divide-y divide-border/60">
            {versions.map((v) => (
              <li key={v.version} className="flex items-center justify-between py-2 text-sm">
                <span className="font-mono">v{v.version}</span>
                <span className="text-xs text-muted-foreground">
                  {v.published_at ? new Date(v.published_at).toLocaleString() : ""}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <ArrowUpRight className="size-3.5" /> publishing stays API-side
        ({`POST /api/v1/registry/${kind}`})
      </p>
    </div>
  );
}
