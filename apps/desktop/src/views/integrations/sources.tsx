// Where plugins come from:
// - Catalog sources (/integrations/sources): the org's catalog indexes — a
//   public URL, or a file in a GitHub or GitLab repository read with the
//   org's GitHub/GitLab integration. Their plugins appear in the Catalog
//   list; installing copies the exact bundle a source lists (checked by
//   sha256) into this server.
// - Install a bundle (/integrations/connect/file): upload a .guildplugin
//   or install one from a URL.

import { useState } from "react";
import { Download, RefreshCw, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";
import { SkeletonRows } from "@guild/ui/components/skeleton";
import { addPluginCatalog, installPluginUrl, removePluginCatalog, uploadPluginBundle } from "../../lib/api/settings";
import { Field } from "../settings/components/field";
import type { CatalogRow } from "./integrations-api";

type SourceKind = "url" | "github" | "gitlab";

interface InstallResult {
  slug: string;
  version: string;
  created: boolean;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The submitted source of the add-source form. */
export function catalogSourceBody(
  kind: SourceKind,
  fields: { url: string; repo: string; ref: string; path: string },
): Record<string, string> {
  if (kind === "url") return { kind, url: fields.url.trim() };
  const location = kind === "github" ? "repo" : "project";
  return { kind, [location]: fields.repo.trim(), ref: fields.ref.trim(), path: fields.path.trim() || "index.json" };
}

export function CatalogSources({
  catalogs,
  error,
  refreshing,
  onRefresh,
}: {
  catalogs: CatalogRow[] | null;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const remove = async (catalog: CatalogRow) => {
    setBusy(catalog.id);
    try {
      await removePluginCatalog(catalog.id);
      toast.success("Source removed", { description: catalog.name });
      await onRefresh();
    } catch (e) {
      toast.error("Could not remove the source", { description: message(e) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="max-w-4xl">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <p className="max-w-prose text-sm text-muted-foreground">
          Indexes of plugins your organization can install. Their plugins appear in the catalog. Installing copies the
          exact bundle a source lists into this server; the source is not needed afterwards.
        </p>
        <Button variant="outline" size="sm" onClick={() => void onRefresh()} disabled={refreshing}>
          <RefreshCw className={`size-3.5 ${refreshing ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>
      {error && (
        <p role="alert" className="mb-4 text-sm text-destructive">
          {error}
        </p>
      )}
      {catalogs === null ? (
        <SkeletonRows rows={3} />
      ) : catalogs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No sources yet. Add one below to list its plugins in the catalog.
        </p>
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {catalogs.map((c) => (
            <li key={c.id} className="flex items-start gap-4 py-4">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{c.name}</p>
                <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{c.label}</p>
                {c.error !== null ? (
                  <p role="alert" className="mt-1.5 text-sm text-destructive">
                    {c.error}
                  </p>
                ) : (
                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {c.plugins.length === 0
                      ? "Lists no plugins"
                      : `${c.plugins.length} ${c.plugins.length === 1 ? "plugin" : "plugins"}`}
                  </p>
                )}
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${c.name}`}
                disabled={busy !== null}
                onClick={() => remove(c)}
              >
                <Trash2 className="size-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <AddSource onAdded={onRefresh} />
    </div>
  );
}

function AddSource({ onAdded }: { onAdded: () => Promise<void> }) {
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
      toast.success("Source added");
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
    <form onSubmit={submit} className="mt-10 max-w-xl space-y-4">
      <h2 className="text-lg font-semibold">Add a source</h2>
      <Field label="Where the index lives">
        <select
          className="h-9 w-full rounded-md border border-border bg-background px-2 text-sm"
          value={kind}
          onChange={(e) => setKind(e.target.value as SourceKind)}
        >
          <option value="url">Public URL</option>
          <option value="github">GitHub repository</option>
          <option value="gitlab">GitLab project</option>
        </select>
      </Field>
      {kind === "url" ? (
        <Field label="Index URL" hint="The source's index.json, e.g. a GitHub Pages or raw file URL.">
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
            Read with this organization's {provider} integration token, so private repositories work. Set up the{" "}
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
            <Field label="Branch or tag" hint="Empty means the default branch.">
              <Input value={fields.ref} onChange={(e) => patch({ ref: e.target.value })} />
            </Field>
          </div>
        </>
      )}
      <Field label="Name" hint="Empty means the name the index declares.">
        <Input value={fields.name} onChange={(e) => patch({ name: e.target.value })} />
      </Field>
      {error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={busy}>
        {busy ? "Reading the index…" : "Add source"}
      </Button>
    </form>
  );
}

export function InstallBundle({ onInstalled }: { onInstalled: (slug: string) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState("");
  const [sha256, setSha256] = useState("");
  const [busy, setBusy] = useState(false);

  const done = (result: InstallResult) => {
    toast.success(`${result.slug} ${result.version} installed`, {
      description: result.created ? "Finish the setup to turn it on." : "The new version is live.",
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
    <div className="max-w-3xl">
      <p className="max-w-prose text-sm text-muted-foreground">
        Install a .guildplugin someone gave you. Installing approves that exact bundle for the whole organization: a
        plugin runs on this server, so install only plugins you trust.
      </p>
      <div className="grid gap-10 md:grid-cols-2">
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">From a file</h2>
          <Input type="file" accept=".guildplugin,.tgz,.gz" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          <Button onClick={upload} disabled={busy || file === null}>
            <Upload className="size-4" /> {busy ? "Installing…" : "Upload and install"}
          </Button>
        </section>
        <form onSubmit={fromUrl} className="space-y-3">
          <h2 className="text-lg font-semibold">From a URL</h2>
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
          <Button type="submit" disabled={busy}>
            <Download className="size-4" /> {busy ? "Installing…" : "Download and install"}
          </Button>
        </form>
      </div>
    </div>
  );
}
