//! Plugin pages of the integration shop:
//! - Catalogs (/settings/integrations/_catalogs): the org's plugin catalogs
//!   — a public index URL, or a file in a GitHub or GitLab repository read
//!   with the org's GitHub/GitLab integration — each listing its plugins
//!   with Install / Update. Installing copies the exact bundle the catalog
//!   lists (checked by sha256) into the org's registry and approves it.
//! - Install plugin (/settings/integrations/_install): upload a
//!   .guildplugin file or install one from a URL.
//! - Traits (/settings/integrations/_traits): which integration answers each
//!   trait (web search, web fetch) when several provide it.

import { useState } from "react";
import { Download, RefreshCw, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@guild/ui/components/button";
import { Badge } from "@guild/ui/components/badge";
import { Input } from "@guild/ui/components/input";
import { SkeletonRows } from "@guild/ui/components/skeleton";
import { EmptyState } from "@guild/ui/components/empty-state";
import { PageHeader } from "../../../components/page-header";
import {
  addPluginCatalog,
  installCatalogPlugin,
  installPluginUrl,
  listPluginCatalogs,
  pluginCatalogsPath,
  removePluginCatalog,
  setTraitBinding,
  traitBindingsPath,
  uploadPluginBundle,
} from "../../../lib/api/settings";
import { useCachedGet } from "../use-cached-api";
import { Field } from "../components/field";
import { TRAIT_LABELS } from "./integration-config";

/** Detail ids of the plugin pages. Integration slugs start with a letter or
 *  digit, so none of them names an integration. */
export const CATALOGS_DETAIL = "_catalogs";
export const INSTALL_PLUGIN_DETAIL = "_install";
export const TRAITS_DETAIL = "_traits";

type SourceKind = "url" | "github" | "gitlab";

type CatalogSource =
  | { kind: "url"; url: string }
  | { kind: "github"; repo: string; ref: string | null; path: string }
  | { kind: "gitlab"; project: string; ref: string | null; path: string };

export interface CatalogPluginRow {
  slug: string;
  title: string;
  summary: string;
  publisher: string;
  categories: string[];
  traits: string[];
  docs_url: string | null;
  latest: string;
  installed_version: string | null;
  update_available: boolean;
  builtin: boolean;
  versions: { version: string; published_at: string | null }[];
}

export interface CatalogRow {
  id: string;
  name: string;
  label: string;
  source: CatalogSource;
  error: string | null;
  plugins: CatalogPluginRow[];
}

interface InstallResult {
  slug: string;
  version: string;
  created: boolean;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The label of one catalog plugin's action, or null when it has none. */
export function catalogAction(p: CatalogPluginRow): string | null {
  if (p.builtin) return null;
  if (p.installed_version === null) return `Install ${p.latest}`;
  if (p.update_available) return `Update to ${p.latest}`;
  return null;
}

/** The submitted source of the add-catalog form. */
export function catalogSourceBody(
  kind: SourceKind,
  fields: { url: string; repo: string; ref: string; path: string },
): Record<string, string> {
  if (kind === "url") return { kind, url: fields.url.trim() };
  const location = kind === "github" ? "repo" : "project";
  return { kind, [location]: fields.repo.trim(), ref: fields.ref.trim(), path: fields.path.trim() || "index.json" };
}

// ---------- catalogs ----------

export function PluginCatalogs({ onBack, onOpen }: { onBack: () => void; onOpen: (slug: string) => void }) {
  const [rows, setRows] = useState<CatalogRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const cached = useCachedGet<{ catalogs: CatalogRow[] }>(pluginCatalogsPath);
  const catalogs = rows ?? cached.data?.catalogs ?? null;

  const refresh = async () => {
    setBusy("refresh");
    try {
      setRows((await listPluginCatalogs<{ catalogs: CatalogRow[] }>(true)).catalogs);
      setError(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const install = async (catalog: CatalogRow, p: CatalogPluginRow) => {
    setBusy(`${catalog.id}/${p.slug}`);
    try {
      const done = await installCatalogPlugin<InstallResult>(catalog.id, p.slug, p.latest);
      toast.success(done.created ? `${p.title} installed` : `${p.title} updated to ${done.version}`, {
        description: done.created ? "Configure and enable it to use it in chats." : undefined,
      });
      await refresh();
      if (done.created) onOpen(done.slug);
    } catch (e) {
      toast.error(`Could not install ${p.title}`, { description: message(e) });
    } finally {
      setBusy(null);
    }
  };

  const remove = async (catalog: CatalogRow) => {
    setBusy(`remove/${catalog.id}`);
    try {
      await removePluginCatalog(catalog.id);
      toast.success("Catalog removed", { description: catalog.name });
      await refresh();
    } catch (e) {
      toast.error("Could not remove the catalog", { description: message(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Plugin catalogs"
        description="Catalogs list integration plugins your organization can install. Installing copies the exact bundle the catalog lists into this server; the catalog is not needed afterwards."
        back={{ label: "Integrations", onClick: onBack }}
        actions={
          <Button size="sm" variant="outline" onClick={refresh} disabled={busy !== null}>
            <RefreshCw className="mr-1 size-4" /> Refresh
          </Button>
        }
      />
      {(error ?? cached.error) && <p className="mb-3 text-sm text-destructive">{error ?? cached.error}</p>}
      {catalogs === null ? (
        <SkeletonRows rows={3} />
      ) : catalogs.length === 0 ? (
        <EmptyState icon={Download} title="No catalogs" hint="Add a catalog below to browse its plugins." />
      ) : (
        <div className="space-y-6">
          {catalogs.map((catalog) => (
            <section key={catalog.id} className="rounded-lg border border-border bg-card">
              <header className="flex items-start gap-3 border-b border-border px-4 py-3">
                <div className="min-w-0 flex-1">
                  <h3 className="truncate text-sm font-medium">{catalog.name}</h3>
                  <p className="truncate font-mono text-xs text-muted-foreground">{catalog.label}</p>
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Remove ${catalog.name}`}
                  disabled={busy !== null}
                  onClick={() => remove(catalog)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </header>
              {catalog.error !== null ? (
                <p role="alert" className="px-4 py-3 text-sm text-destructive">
                  {catalog.error}
                </p>
              ) : catalog.plugins.length === 0 ? (
                <p className="px-4 py-3 text-sm text-muted-foreground">This catalog lists no plugins.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {catalog.plugins.map((p) => {
                    const action = catalogAction(p);
                    return (
                      <li key={p.slug} className="flex items-start gap-3 px-4 py-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{p.title}</span>
                            <span className="text-xs text-muted-foreground">
                              {p.publisher !== "" ? `${p.publisher} · ` : ""}v{p.latest}
                            </span>
                            {p.traits.map((t) => (
                              <Badge key={t} variant="outline">
                                {TRAIT_LABELS[t] ?? t}
                              </Badge>
                            ))}
                          </div>
                          {p.summary !== "" && <p className="mt-0.5 text-xs text-muted-foreground">{p.summary}</p>}
                          {p.builtin && (
                            <p className="mt-0.5 text-xs text-muted-foreground">
                              Shares its name with a built-in integration; it cannot be installed.
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          {p.installed_version !== null && (
                            <button
                              type="button"
                              className="text-xs text-muted-foreground hover:text-foreground"
                              onClick={() => onOpen(p.slug)}
                            >
                              Installed v{p.installed_version}
                            </button>
                          )}
                          {action !== null && (
                            <Button size="sm" disabled={busy !== null} onClick={() => install(catalog, p)}>
                              {busy === `${catalog.id}/${p.slug}` ? "Installing…" : action}
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>
          ))}
        </div>
      )}
      <AddCatalog onAdded={refresh} />
    </div>
  );
}

function AddCatalog({ onAdded }: { onAdded: () => Promise<void> }) {
  const [kind, setKind] = useState<SourceKind>("url");
  const [fields, setFields] = useState({ url: "", repo: "", ref: "", path: "index.json", name: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const patch = (p: Partial<typeof fields>) => setFields((f) => ({ ...f, ...p }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await addPluginCatalog({ name: fields.name.trim(), source: catalogSourceBody(kind, fields) });
      toast.success("Catalog added");
      setFields({ url: "", repo: "", ref: "", path: "index.json", name: "" });
      await onAdded();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const provider = kind === "github" ? "GitHub" : "GitLab";
  return (
    <form onSubmit={submit} className="mt-8 max-w-xl space-y-4 rounded-lg border border-border bg-card p-4">
      <h3 className="text-sm font-medium">Add a catalog</h3>
      <Field label="Source">
        <select
          className="h-9 w-full rounded-md border border-border bg-card px-2 text-sm"
          value={kind}
          onChange={(e) => setKind(e.target.value as SourceKind)}
        >
          <option value="url">Public URL</option>
          <option value="github">GitHub repository</option>
          <option value="gitlab">GitLab project</option>
        </select>
      </Field>
      {kind === "url" ? (
        <Field label="Index URL" hint="The catalog's index.json, e.g. a GitHub Pages or raw file URL.">
          <Input
            required
            type="url"
            placeholder="https://example.github.io/guild-plugins/index.json"
            value={fields.url}
            onChange={(e) => patch({ url: e.target.value })}
          />
        </Field>
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            Read with this organization's {provider} integration token, so private repositories work. Configure the{" "}
            {provider} integration first.
          </p>
          <Field label={kind === "github" ? "Repository" : "Project"}>
            <Input
              required
              placeholder={kind === "github" ? "owner/repo" : "group/project"}
              value={fields.repo}
              onChange={(e) => patch({ repo: e.target.value })}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Index path">
              <Input value={fields.path} onChange={(e) => patch({ path: e.target.value })} />
            </Field>
            <Field label="Branch or tag" hint="Empty = the default branch.">
              <Input value={fields.ref} onChange={(e) => patch({ ref: e.target.value })} />
            </Field>
          </div>
        </>
      )}
      <Field label="Name" hint="Empty = the name the index declares.">
        <Input value={fields.name} onChange={(e) => patch({ name: e.target.value })} />
      </Field>
      {error !== null && <p className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end">
        <Button type="submit" disabled={busy}>
          {busy ? "Reading the catalog…" : "Add catalog"}
        </Button>
      </div>
    </form>
  );
}

// ---------- install from a file or URL ----------

export function InstallPlugin({ onBack, onInstalled }: { onBack: () => void; onInstalled: (slug: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [sha256, setSha256] = useState("");
  const [busy, setBusy] = useState(false);

  const done = (result: InstallResult) => {
    toast.success(`${result.slug} ${result.version} installed`, {
      description: result.created ? "Configure and enable it to use it in chats." : "The new version is live.",
    });
    onInstalled(result.slug);
  };

  const upload = async () => {
    if (file === null) return;
    setBusy(true);
    try {
      done(await uploadPluginBundle<InstallResult>(file));
    } catch (e) {
      toast.error("Could not install the plugin", { description: message(e) });
    } finally {
      setBusy(false);
    }
  };

  const fromUrl = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      done(await installPluginUrl<InstallResult>(url.trim(), sha256.trim().toLowerCase()));
    } catch (err) {
      toast.error("Could not install the plugin", { description: message(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <PageHeader
        title="Install plugin"
        description="Install an integration plugin bundle (.guildplugin). Installing approves that exact bundle for the whole organization: a code plugin runs on this server, so install only plugins you trust."
        back={{ label: "Integrations", onClick: onBack }}
      />
      <div className="max-w-xl space-y-6">
        <section className="space-y-3 rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-medium">Upload a file</h3>
          <Input type="file" accept=".guildplugin,.tgz,.gz" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <div className="flex justify-end">
            <Button onClick={upload} disabled={busy || file === null}>
              <Upload className="mr-1 size-4" /> {busy ? "Installing…" : "Upload and install"}
            </Button>
          </div>
        </section>
        <form onSubmit={fromUrl} className="space-y-3 rounded-lg border border-border bg-card p-4">
          <h3 className="text-sm font-medium">From a URL</h3>
          <Field label="Bundle URL">
            <Input
              required
              type="url"
              placeholder="https://github.com/acme/plugin/releases/download/v1.0.0/acme-1.0.0.guildplugin"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </Field>
          <Field label="SHA-256" hint="Optional. When given, the download must match it.">
            <Input className="font-mono" value={sha256} onChange={(e) => setSha256(e.target.value)} />
          </Field>
          <div className="flex justify-end">
            <Button type="submit" disabled={busy}>
              <Download className="mr-1 size-4" /> {busy ? "Installing…" : "Download and install"}
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ---------- trait bindings ----------

interface TraitRow {
  name: string;
  description: string;
  provider: string | null;
  active: string | null;
  providers: { slug: string; title: string; enabled: boolean }[];
}

export function TraitBindings({ onBack }: { onBack: () => void }) {
  const list = useCachedGet<{ traits: TraitRow[] }>(traitBindingsPath);
  const [saving, setSaving] = useState<string | null>(null);

  const bind = async (trait: string, provider: string) => {
    setSaving(trait);
    try {
      await setTraitBinding(trait, provider === "" ? null : provider);
      list.reload();
    } catch (e) {
      toast.error("Could not save", { description: message(e) });
    } finally {
      setSaving(null);
    }
  };

  return (
    <div>
      <PageHeader
        title="Traits"
        description="A trait is a capability chats get under one shared tool name. When several integrations provide one, pick which answers; without a choice, the first enabled one does."
        back={{ label: "Integrations", onClick: onBack }}
      />
      {list.error && <p className="mb-3 text-sm text-destructive">{list.error}</p>}
      {list.data === null ? (
        <SkeletonRows rows={2} />
      ) : (
        <ul className="max-w-2xl divide-y divide-border rounded-lg border border-border bg-card">
          {list.data.traits.map((t) => {
            const active = t.providers.find((p) => p.slug === t.active);
            return (
              <li key={t.name} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {TRAIT_LABELS[t.name] ?? t.name}{" "}
                    <span className="font-mono text-xs text-muted-foreground">{t.name}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {active !== undefined
                      ? `Chats use ${active.title}.`
                      : t.providers.length === 0
                        ? "No installed integration provides it."
                        : "No provider is enabled."}
                  </p>
                </div>
                <select
                  aria-label={`Provider of ${t.name}`}
                  className="h-8 min-w-48 rounded-md border border-border bg-card px-2 text-xs"
                  value={t.provider ?? ""}
                  disabled={saving !== null || t.providers.length === 0}
                  onChange={(e) => bind(t.name, e.target.value)}
                >
                  <option value="">First enabled</option>
                  {t.providers.map((p) => (
                    <option key={p.slug} value={p.slug}>
                      {p.title}
                      {p.enabled ? "" : " (not enabled)"}
                    </option>
                  ))}
                </select>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
