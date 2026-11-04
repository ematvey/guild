// A catalog landing page: what the integration is (its README), what an
// admin needs before installing it, the tools it gives agents, where it
// comes from, and the one action — install, which lands on its
// configuration. A plugin a catalog source lists is read from its bundle
// before anything is installed; one the server already holds reads from
// its own manifest.

import { useState } from "react";
import { toast } from "sonner";
import { ExternalLink, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@guild/ui/components/button";
import { SkeletonRows } from "@guild/ui/components/skeleton";
import { useCachedGet } from "../settings/use-cached-api";
import { createIntegration, installCatalogPlugin } from "../../lib/api/settings";
import { catalogLandingPath, type CatalogLanding, type DeclaredTool, type FieldSpec } from "./integrations-api";
import { ExternalLinkText, Logo, SOURCE_LABELS, linkHost, traitLabel } from "./brand";
import type { CatalogEntry } from "./model";
import { Readme } from "./prose";
import { fieldLabel } from "./configuration";

interface LandingData {
  title: string;
  summary: string;
  publisher: string;
  logo: string;
  readme: string;
  fallbackText: string;
  docsUrl: string | null;
  fields: FieldSpec[];
  tools: DeclaredTool[];
  traits: string[];
  version: string;
  origin: string;
  /** A code plugin bundle: installing approves this exact hash. */
  sha256: string | null;
}

function fromEntry(entry: CatalogEntry, remote: CatalogLanding | null): LandingData | null {
  if (entry.kind === "local") {
    const i = entry.item;
    return {
      title: i.title,
      summary: i.summary,
      publisher: i.publisher,
      logo: i.logo,
      readme: i.readme,
      fallbackText: i.description,
      docsUrl: i.docs_url,
      fields: i.settings?.fields ?? [],
      tools: i.tools,
      traits: Object.keys(i.traits),
      version: i.version,
      origin: i.source === "builtin" ? SOURCE_LABELS.builtin : "Approved for your organization",
      sha256: null,
    };
  }
  if (remote === null) return null;
  const m = remote.manifest;
  const declared = m.tools?.declared ?? [];
  const classes = m.tools?.classes ?? {};
  return {
    title: m.title ?? entry.title,
    summary: m.summary ?? entry.summary,
    publisher: m.publisher ?? entry.publisher,
    logo: remote.logo,
    readme: remote.readme,
    fallbackText: entry.summary,
    docsUrl: m.docs_url ?? entry.row.docs_url,
    fields: m.settings?.fields ?? [],
    tools:
      declared.length > 0
        ? declared
        : Object.entries(classes).map(([name, cls]) => ({ name, class: cls, description: "" })),
    traits: Object.keys(m.traits ?? {}),
    version: remote.version.version,
    origin: remote.catalog.name,
    sha256: remote.version.sha256,
  };
}

function Needs({ fields }: { fields: FieldSpec[] }) {
  const needed = fields.filter((f) => f.kind === "secret" || f.required);
  if (needed.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing. It works as soon as it is on.</p>;
  }
  return (
    <ul className="space-y-2.5">
      {needed.map((f) => (
        <li key={f.name} className="flex items-start gap-2.5 text-sm">
          <KeyRound className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            {fieldLabel(f)}
            {!f.required && <span className="ml-1.5 text-xs text-muted-foreground">optional</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}

function AsideSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-3 text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

export function CatalogLandingPage({
  entry,
  onInstalled,
}: {
  entry: CatalogEntry;
  onInstalled: (slug: string) => void;
}) {
  const [version, setVersion] = useState<string | null>(null);
  const remotePath = entry.kind === "remote" ? catalogLandingPath(entry.catalogId, entry.slug, version) : null;
  const remote = useCachedGet<CatalogLanding>(remotePath);
  const data = fromEntry(entry, remote.data);
  const [busy, setBusy] = useState(false);

  const install = async () => {
    setBusy(true);
    try {
      if (entry.kind === "local") {
        await createIntegration({ name: entry.slug });
      } else {
        await installCatalogPlugin(entry.catalogId, entry.slug, version ?? entry.row.latest);
      }
      toast.success("Installed", { description: `${data?.title ?? entry.title}: finish the setup to turn it on.` });
      onInstalled(entry.slug);
    } catch (e) {
      toast.error("Could not install it", { description: e instanceof Error ? e.message : String(e) });
      setBusy(false);
    }
  };

  if (data === null) {
    return remote.error ? (
      <div role="alert" className="max-w-prose">
        <p className="text-sm font-medium">
          Could not read this plugin from {entry.kind === "remote" ? entry.catalogName : "its source"}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{remote.error}</p>
        <Button variant="outline" size="sm" className="mt-3" onClick={() => remote.reload()}>
          Try again
        </Button>
      </div>
    ) : (
      <div className="space-y-4">
        <SkeletonRows rows={6} />
      </div>
    );
  }

  const versions = entry.kind === "remote" ? entry.row.versions : [];
  const writes = data.tools.filter((t) => t.class !== "read").length;

  return (
    <div>
      <header className="flex flex-wrap items-start gap-6 border-b border-border pb-8">
        <Logo svg={data.logo} title={data.title} size="size-16" />
        <div className="min-w-0 flex-1 basis-80">
          <h1 className="text-2xl font-semibold">{data.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {data.publisher || "Unknown publisher"}
            {data.version !== "" && <> · version {data.version}</>}
          </p>
          <p className="mt-4 max-w-prose text-base leading-relaxed">{data.summary}</p>
        </div>
        <div className="flex w-full flex-col gap-2 sm:w-56">
          <Button size="lg" onClick={install} disabled={busy}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {busy ? "Installing…" : `Install ${data.title}`}
          </Button>
          {versions.length > 1 && (
            <select
              aria-label="Version to install"
              className="h-9 rounded-md border border-border bg-background px-2 text-sm"
              value={version ?? (entry.kind === "remote" ? entry.row.latest : "")}
              onChange={(e) => setVersion(e.target.value)}
            >
              {versions.map((v, i) => (
                <option key={v.version} value={v.version}>
                  {v.version}
                  {i === 0 ? " (latest)" : ""}
                </option>
              ))}
            </select>
          )}
          <p className="text-xs text-muted-foreground">
            Installs turned off. You add credentials, test, then turn it on.
          </p>
        </div>
      </header>

      <div className="grid gap-12 pt-8 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 max-w-[72ch]">
          {data.readme.trim() !== "" ? (
            <Readme markdown={data.readme} />
          ) : (
            <p className="whitespace-pre-line text-base leading-[1.75] text-foreground/90">{data.fallbackText}</p>
          )}
        </div>
        <aside className="min-w-0 space-y-9">
          <AsideSection title="You will need">
            <Needs fields={data.fields} />
          </AsideSection>
          {data.tools.length > 0 && (
            <AsideSection title={`${data.tools.length} ${data.tools.length === 1 ? "tool" : "tools"} for agents`}>
              <ul className="space-y-1.5">
                {data.tools.map((t) => (
                  <li key={t.name} className="flex items-baseline justify-between gap-3">
                    <span className="min-w-0 truncate font-mono text-xs" title={t.description}>
                      {t.name}
                    </span>
                    {t.class !== "read" && (
                      <span className="shrink-0 text-xs capitalize text-amber-700 dark:text-amber-400">{t.class}</span>
                    )}
                  </li>
                ))}
              </ul>
              {writes > 0 && (
                <p className="mt-3 text-xs text-muted-foreground">
                  {writes === 1 ? "One tool changes" : `${writes} tools change`} data. You choose who may call them and
                  when a person approves.
                </p>
              )}
            </AsideSection>
          )}
          {data.traits.length > 0 && (
            <AsideSection title="Can answer">
              <p className="text-sm">{data.traits.map(traitLabel).join(", ")}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Shared tools every chat has. One integration answers each.
              </p>
            </AsideSection>
          )}
          <AsideSection title="Source">
            <p className="text-sm">{data.origin}</p>
            {data.sha256 !== null && (
              <p className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
                <span>
                  Runs on your Guild server. Installing approves exactly this bundle,{" "}
                  <span className="font-mono">{data.sha256.slice(0, 12)}</span>.
                </span>
              </p>
            )}
            {data.docsUrl && (
              <p className="mt-3 text-sm">
                <ExternalLinkText href={data.docsUrl}>
                  {linkHost(data.docsUrl)} <ExternalLink className="size-3.5" />
                </ExternalLinkText>
              </p>
            )}
          </AsideSection>
        </aside>
      </div>
    </div>
  );
}
