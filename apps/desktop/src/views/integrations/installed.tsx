// One installed integration: a header with its on/off switch and status,
// then the tabs — Overview (what needs attention, recent usage, what it
// gives agents), Configuration, Tools, Usage and About (README, version,
// removal). The tab is part of the address.

import { useState } from "react";
import { toast } from "sonner";
import { ArrowUpCircle, CircleAlert, ExternalLink, Loader2, Trash2 } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@guild/ui/components/alert-dialog";
import { useCachedGet } from "../settings/use-cached-api";
import {
  deleteIntegration,
  installCatalogPlugin,
  setTraitBinding,
  traitBindingsPath,
  updateIntegration,
} from "../../lib/api/settings";
import type { ShopItem, TraitRow, UsageSummaryRow } from "./integrations-api";
import type { InstalledTab } from "./integrations-route";
import { ExternalLinkText, Logo, SOURCE_LABELS, categoryLabel, linkHost, traitLabel } from "./brand";
import { installedStatus, statusLine, type AvailableUpdate, type InstalledStatus } from "./model";
import { ConfigurationTab } from "./configuration";
import { ToolsTab } from "./tools";
import { AccessTab } from "./access";
import { CallsChart, UsageStats, UsageTab, useIntegrationUsage } from "./usage";
import { Readme } from "./prose";
import { StatusDot } from "./status-dot";

const TABS: [InstalledTab, string][] = [
  ["overview", "Overview"],
  ["configuration", "Configuration"],
  ["access", "Access"],
  ["tools", "Tools"],
  ["usage", "Usage"],
  ["about", "About"],
];

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The on/off switch. Turning on runs the connection test on the server
 *  and refuses while credentials are missing. */
function EnableSwitch({ item, onChanged }: { item: ShopItem; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    try {
      await updateIntegration(item.id!, { enabled: !item.enabled });
      toast.success(item.enabled ? "Turned off" : "Turned on", { description: item.title });
      onChanged();
    } catch (e) {
      toast.error(item.enabled ? "Could not turn it off" : "Could not turn it on", { description: message(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={item.enabled}
      aria-label={item.enabled ? `Turn ${item.title} off` : `Turn ${item.title} on`}
      disabled={busy}
      onClick={toggle}
      className="group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
    >
      <span className="text-muted-foreground">{busy ? "Checking…" : item.enabled ? "On" : "Off"}</span>
      <span
        className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
          item.enabled ? "bg-foreground" : "bg-muted-foreground/30"
        }`}
      >
        <span
          className={`inline-block size-4 rounded-full bg-background shadow-sm transition-transform ${
            item.enabled ? "translate-x-[18px]" : "translate-x-0.5"
          }`}
        />
      </span>
    </button>
  );
}

function Attention({ status, onTab }: { status: InstalledStatus; onTab: (tab: InstalledTab) => void }) {
  if (status.kind === "needs_setup") {
    return (
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-amber-500/40 bg-amber-500/5 px-5 py-4">
        <CircleAlert className="size-5 shrink-0 text-amber-600 dark:text-amber-400" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Finish setting it up</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Agents can't use it until you add {status.missing.join(", ")}.
          </p>
        </div>
        <Button onClick={() => onTab("configuration")}>Open configuration</Button>
      </div>
    );
  }
  if (status.kind === "failing") {
    return (
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-destructive/40 bg-destructive/5 px-5 py-4">
        <CircleAlert className="size-5 shrink-0 text-destructive" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">The last call failed</p>
          {status.error && <p className="mt-0.5 break-words text-sm text-muted-foreground">{status.error}</p>}
        </div>
        <Button variant="outline" onClick={() => onTab("usage")}>
          See failures
        </Button>
      </div>
    );
  }
  return null;
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="py-2.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

function DetailsList({ item, update }: { item: ShopItem; update: AvailableUpdate | undefined }) {
  return (
    <dl className="divide-y divide-border border-y border-border">
      <Detail label="Source">{SOURCE_LABELS[item.source]}</Detail>
      {item.version !== "" && (
        <Detail label="Version">
          {item.version}
          {update && <span className="ml-2 text-xs text-muted-foreground">{update.latest} available</span>}
        </Detail>
      )}
      <Detail label="Publisher">{item.publisher || "—"}</Detail>
      {item.categories.length > 0 && <Detail label="Category">{item.categories.map(categoryLabel).join(", ")}</Detail>}
      {item.docs_url && (
        <Detail label="Documentation">
          <ExternalLinkText href={item.docs_url}>
            {linkHost(item.docs_url)} <ExternalLink className="size-3.5" />
          </ExternalLinkText>
        </Detail>
      )}
    </dl>
  );
}

/** The shared tools this integration can answer (web search, …) and which
 *  integration answers each one now. */
function TraitProviders({ item }: { item: ShopItem }) {
  const declared = Object.keys(item.traits);
  const res = useCachedGet<{ traits: TraitRow[] }>(declared.length > 0 ? traitBindingsPath : null);
  const [busy, setBusy] = useState<string | null>(null);
  if (declared.length === 0) return null;
  const rows = (res.data?.traits ?? []).filter((t) => declared.includes(t.name));
  const choose = async (trait: string) => {
    setBusy(trait);
    try {
      await setTraitBinding(trait, item.name);
      res.reload();
    } catch (e) {
      toast.error("Could not change the provider", { description: message(e) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section>
      <h3 className="text-sm font-medium">Shared tools</h3>
      <p className="mt-1 text-xs text-muted-foreground">
        Chats call these by one shared name. When several integrations can answer, one is chosen.
      </p>
      <ul className="mt-3 divide-y divide-border border-y border-border">
        {rows.map((t) => {
          const mine = t.active === item.name;
          const other = t.providers.find((p) => p.slug === t.active);
          return (
            <li key={t.name} className="flex flex-wrap items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm">{traitLabel(t.name)}</p>
                <p className="text-xs text-muted-foreground">
                  {mine
                    ? "Answered by this integration"
                    : other
                      ? `Answered by ${other.title}`
                      : item.enabled
                        ? "Not answered yet"
                        : "Answered once this integration is on"}
                </p>
              </div>
              {!mine && (
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => choose(t.name)}>
                  {busy === t.name ? "Saving…" : "Use this one"}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Overview({
  item,
  status,
  update,
  onTab,
}: {
  item: ShopItem;
  status: InstalledStatus;
  update: AvailableUpdate | undefined;
  onTab: (tab: InstalledTab) => void;
}) {
  const usage = useIntegrationUsage(item.id!, 30);
  return (
    <div className="grid gap-12 xl:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="min-w-0 space-y-10">
        <Attention status={status} onTab={onTab} />
        <section>
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-lg font-semibold">Last 30 days</h2>
            <button
              type="button"
              className="text-xs text-muted-foreground hover:text-foreground"
              onClick={() => onTab("usage")}
            >
              Usage details
            </button>
          </div>
          {usage.data === null ? (
            <div className="mt-4 h-40 animate-pulse rounded-md bg-muted/60" />
          ) : usage.data.totals.calls === 0 ? (
            <p className="mt-3 text-sm text-muted-foreground">
              {item.enabled
                ? "No calls yet. Usage shows up here once an agent calls one of the tools."
                : "No calls. Turn it on to give agents its tools."}
            </p>
          ) : (
            <div className="mt-4 space-y-6">
              <UsageStats usage={usage.data} />
              <CallsChart usage={usage.data} height={140} />
            </div>
          )}
        </section>
        {item.tools.length > 0 && (
          <section>
            <div className="flex items-baseline justify-between gap-3">
              <h2 className="text-lg font-semibold">What agents can do</h2>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => onTab("tools")}
              >
                Manage tools
              </button>
            </div>
            <ul className="mt-3 grid gap-x-10 gap-y-4 md:grid-cols-2">
              {item.tools.map((t) => (
                <li key={t.name} className="min-w-0">
                  <p className="flex items-baseline gap-2 font-mono text-xs">
                    {t.name}
                    {t.class !== "read" && (
                      <span className="font-sans text-xs capitalize text-amber-700 dark:text-amber-400">{t.class}</span>
                    )}
                  </p>
                  <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground" title={t.description}>
                    {t.description}
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <aside className="min-w-0 space-y-8">
        <DetailsList item={item} update={update} />
        <TraitProviders item={item} />
      </aside>
    </div>
  );
}

function About({
  item,
  update,
  onChanged,
  onRemoved,
}: {
  item: ShopItem;
  update: AvailableUpdate | undefined;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState<"remove" | "update" | null>(null);
  const remove = async () => {
    setBusy("remove");
    try {
      await deleteIntegration(item.id!);
      toast.success("Removed", { description: item.title });
      onRemoved();
    } catch (e) {
      toast.error("Could not remove it", { description: message(e) });
      setBusy(null);
    }
  };
  const doUpdate = async () => {
    if (!update) return;
    setBusy("update");
    try {
      await installCatalogPlugin(update.catalogId, item.name, update.latest);
      toast.success(`Updated to ${update.latest}`, { description: item.title });
      onChanged();
    } catch (e) {
      toast.error("Could not update", { description: message(e) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="grid gap-12 xl:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="min-w-0 max-w-[72ch]">
        {item.readme.trim() !== "" ? (
          <Readme markdown={item.readme} />
        ) : (
          <p className="text-base leading-[1.75] text-foreground/90 whitespace-pre-line">
            {item.description || item.summary}
          </p>
        )}
      </div>
      <aside className="min-w-0 space-y-8">
        {update && (
          <section className="rounded-lg border border-border px-4 py-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <ArrowUpCircle className="size-4" /> Version {update.latest} is available
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              From {update.catalogName}. Settings and credentials carry over.
            </p>
            <Button className="mt-3 w-full" onClick={doUpdate} disabled={busy !== null}>
              {busy === "update" && <Loader2 className="size-4 animate-spin" />}
              Update to {update.latest}
            </Button>
          </section>
        )}
        <DetailsList item={item} update={update} />
        <section>
          <h3 className="text-sm font-medium">Remove</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Deletes its configuration and stored credentials. Its tools leave every chat. You can install it again
            later.
          </p>
          <Button variant="outline" className="mt-3 text-destructive" onClick={() => setConfirm(true)}>
            <Trash2 className="size-4" /> Remove {item.title}
          </Button>
        </section>
      </aside>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {item.title}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its configuration and stored credentials are deleted and its tools leave every chat. This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={busy !== null}
              onClick={remove}
            >
              {busy === "remove" ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

export function InstalledDetail({
  item,
  tab,
  usage,
  update,
  onTab,
  onChanged,
  onRemoved,
  onOpenAgent,
}: {
  item: ShopItem;
  tab: InstalledTab;
  usage: UsageSummaryRow | undefined;
  update: AvailableUpdate | undefined;
  onTab: (tab: InstalledTab) => void;
  /** Opens one agent's settings (the Access tab's agent links). */
  onOpenAgent: (agentId: string) => void;
  onChanged: () => void;
  onRemoved: () => void;
}) {
  const status = installedStatus(item, usage);
  const isMcp = typeof item.config?.mcp === "object" && item.config.mcp !== null;
  return (
    <div>
      <header className="flex flex-wrap items-start gap-5">
        <Logo svg={item.logo} title={item.title} size="size-12" />
        <div className="min-w-0 flex-1">
          <p className="max-w-prose text-sm text-muted-foreground">{item.summary}</p>
          <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <StatusDot status={status} />
            {statusLine(status)}
            {update && (
              <button
                type="button"
                onClick={() => onTab("about")}
                className="ml-2 text-foreground underline-offset-2 hover:underline"
              >
                Update to {update.latest}
              </button>
            )}
          </p>
        </div>
        <EnableSwitch item={item} onChanged={onChanged} />
      </header>
      <div
        role="tablist"
        aria-label={`${item.title} sections`}
        className="mt-8 flex gap-1 overflow-x-auto border-b border-border"
      >
        {TABS.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            onClick={() => onTab(id)}
            className={`-mb-px shrink-0 border-b-2 px-3 pb-2.5 pt-1 text-sm outline-none transition-colors focus-visible:text-foreground ${
              tab === id
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="pt-8">
        {tab === "overview" && <Overview item={item} status={status} update={update} onTab={onTab} />}
        {tab === "configuration" && (
          <ConfigurationTab key={JSON.stringify([item.id, item.config])} item={item} onSaved={onChanged} />
        )}
        {tab === "access" && <AccessTab id={item.id!} slug={item.name} title={item.title} onOpenAgent={onOpenAgent} />}
        {tab === "tools" && <ToolsTab id={item.id!} isMcp={isMcp} />}
        {tab === "usage" && <UsageTab id={item.id!} />}
        {tab === "about" && <About item={item} update={update} onChanged={onChanged} onRemoved={onRemoved} />}
      </div>
    </div>
  );
}
