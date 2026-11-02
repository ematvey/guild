//! IntegrationsSection — the integration shop. The list is a card grid of
//! every integration the server ships or the registry approved: logo, title,
//! one-line summary, categories, and install state. Opening a card is the
//! install and configure flow: the detail page shows the long description,
//! adds the integration when the admin asks for it, and then renders the
//! settings form from the manifest field schema (no per-connector UI), the
//! secrets editor (masked previews, write-only values), and per-tool
//! curation (enable/disable + approval policy per declared tool).

import { useMemo, useState } from "react";
import type { SectionDetailProps } from "../section-nav";
import { useCachedGet } from "../use-cached-api";
import { createIntegration, SETTINGS_PATHS } from "../../../lib/api/settings";
import { ExternalLink, Plug, Plus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@guild/ui/components/button";
import { Badge } from "@guild/ui/components/badge";
import { Input } from "@guild/ui/components/input";
import { SkeletonRows, SkeletonForm } from "@guild/ui/components/skeleton";
import { PageHeader } from "../../../components/page-header";
import { EmptyState } from "@guild/ui/components/empty-state";

import {
  CategoryBadges,
  ConfiguredIntegration,
  Logo,
  StateBadge,
  TRAIT_LABELS,
  type ShopItem,
} from "./integration-config";

export default function IntegrationsSection({ detail = null, onDetailChange }: SectionDetailProps) {
  const list = useCachedGet<{ items: ShopItem[] }>(SETTINGS_PATHS.integrations);
  const items = list.data?.items ?? null;
  const error = list.error;
  const reload = list.reload;
  const [query, setQuery] = useState("");

  const open = (slug: string | null) => onDetailChange(slug);

  const shown = useMemo(() => {
    if (items === null) return null;
    const q = query.trim().toLowerCase();
    if (q === "") return items;
    return items.filter((i) => `${i.name} ${i.title} ${i.summary} ${i.categories.join(" ")}`.toLowerCase().includes(q));
  }, [items, query]);

  if (detail !== null) {
    if (items === null) {
      if (error)
        return (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        );
      return (
        <div className="space-y-2">
          <SkeletonForm />
        </div>
      );
    }
    const item = items.find((i) => i.name === detail) ?? null;
    if (item === null) {
      return (
        <div>
          <PageHeader title="Integrations" back={{ label: "Integrations", onClick: () => open(null) }} />
          <p className="text-sm text-muted-foreground">This integration is not available on this server.</p>
        </div>
      );
    }
    return (
      <IntegrationDetail
        key={item.name}
        item={item}
        onChanged={reload}
        onBack={() => {
          reload();
          open(null);
        }}
      />
    );
  }

  return (
    <div>
      <PageHeader
        title="Integrations"
        description="Connect the tools your chats use. Each integration brings its own tools, its own settings, and its own credentials."
      />
      {error && <p className="mb-3 text-sm text-destructive">{error}</p>}
      <div className="mb-4 max-w-sm">
        <Input
          type="search"
          placeholder="Search integrations…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      {shown === null ? (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <SkeletonRows rows={3} />
          <SkeletonRows rows={3} />
          <SkeletonRows rows={3} />
        </div>
      ) : shown.length === 0 ? (
        <EmptyState
          icon={Plug}
          title={query === "" ? "No integrations available" : "No matches"}
          hint={
            query === ""
              ? "This build ships no integrations and the registry has no approved plugins."
              : "Try another word."
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((item) => (
            <button
              key={item.name}
              onClick={() => open(item.name)}
              className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4 text-left transition-colors hover:bg-accent/60"
            >
              <div className="flex items-start gap-3">
                <Logo svg={item.logo} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{item.title}</p>
                  <p className="truncate text-xs text-muted-foreground">{item.publisher}</p>
                </div>
              </div>
              <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">{item.summary}</p>
              <div className="mt-auto flex items-center justify-between gap-2">
                <CategoryBadges categories={item.categories} />
                {item.configured ? (
                  <StateBadge item={item} />
                ) : (
                  <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                    <Plus className="size-3.5" /> Add
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// Per-credential widgets: every secret name renders as a purposeful,
// labeled input — password/textarea/email by the credential's shape —
// never a generic name+value pair.
function Storefront({ item, onAdded }: { item: ShopItem; onAdded: () => void }) {
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      await createIntegration({ name: item.name });
      toast.success("Integration added", { description: item.title });
      onAdded();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.error("Could not add integration", { description: msg });
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex flex-wrap items-start gap-4">
          <Logo svg={item.logo} size="size-12" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <h3 className="text-base font-semibold">{item.title}</h3>
              <span className="text-xs text-muted-foreground">v{item.version}</span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{item.summary}</p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <CategoryBadges categories={item.categories} />
              {Object.keys(item.traits).length > 0 && (
                <Badge variant="outline">
                  Provides{" "}
                  {Object.keys(item.traits)
                    .map((t) => TRAIT_LABELS[t] ?? t)
                    .join(", ")}
                </Badge>
              )}
            </div>
          </div>
          <Button onClick={add} disabled={busy}>
            <Plus className="size-4" /> {busy ? "Adding…" : "Add integration"}
          </Button>
        </div>
        <p className="mt-4 whitespace-pre-line text-sm leading-relaxed text-muted-foreground">{item.description}</p>
        {item.docs_url !== null && (
          <a
            href={item.docs_url}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="size-3.5" /> Documentation
          </a>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Adding it creates a disabled configuration. Fill the settings and credentials, then enable it.
      </p>
    </div>
  );
}

function IntegrationDetail({ item, onChanged, onBack }: { item: ShopItem; onChanged: () => void; onBack: () => void }) {
  if (!item.configured) {
    return (
      <div>
        <PageHeader title={item.title} description={item.summary} back={{ label: "Integrations", onClick: onBack }} />
        <Storefront item={item} onAdded={onChanged} />
      </div>
    );
  }
  // The saved row keys the form: a save reloads the list, and a changed row
  // remounts the form from it.
  return (
    <ConfiguredIntegration
      key={JSON.stringify([item.id, item.enabled, item.config])}
      item={item}
      onChanged={onChanged}
      onBack={onBack}
    />
  );
}
