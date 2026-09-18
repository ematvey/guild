//! SkillsSection — locally discovered skills (skills design §3): provenance
//! badges, enable/disable, publish to the org registry, uninstall. Machine-
//! local state, so it talks JSON-RPC to the app-server, not the admin API.

import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, Upload, Ban, CircleCheck, Trash2, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { rpcCall } from "../../../transport";
import { resolveProjectDir } from "../resolve-project-dir";
import { daemonFs, listSkills, setSkillDisabled } from "../../../lib/context";
import { Button } from "@guild/ui/components/button";
import { Badge } from "@guild/ui/components/badge";
import { Input } from "@guild/ui/components/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from "@guild/ui/components/dialog";
import { PageHeader } from "../components/page-header";
import { EmptyState } from "../components/empty-state";
import { Spinner } from "@guild/ui/components/spinner";

interface SkillProvenance {
  source: string;
  slug: string;
  version: string;
  publisher: string;
  published_by_me: boolean;
  review_status: string;
  installed_at: string;
  bundle_hash: string;
}

interface SkillRow {
  name: string;
  description: string;
  path: string;
  scope: string; // repo | user | legacy
  provenance: SkillProvenance | null;
  installed: boolean;
  published_by_me: boolean;
  disabled: boolean;
}

function SourceBadge({ row }: { row: SkillRow }) {
  if (row.published_by_me) {
    const v = row.provenance?.version;
    return (
      <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400">
        Yours{v ? ` · v${v}` : ""}
      </Badge>
    );
  }
  if (row.installed) {
    const p = row.provenance;
    return (
      <Badge variant="outline" className="border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400">
        Installed{p?.version ? ` v${p.version}` : ""}
        {p?.publisher ? ` by ${p.publisher}` : ""}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      Local
    </Badge>
  );
}

const SCOPE_LABELS: Record<string, string> = {
  repo: "this folder",
  user: "all folders",
  legacy: "legacy location",
};

export default function SkillsSection() {
  const [rows, setRows] = useState<SkillRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<SkillRow | null>(null);
  const [version, setVersion] = useState("0.1.0");

  const reload = useCallback(async () => {
    setError(null);
    try {
      // Discovery moved client-side (lib/context.ts over the fs bridge).
      const fs = daemonFs(rpcCall);
      const scopes = await fs.scopes();
      const rows = await listSkills(fs, scopes, (await resolveProjectDir()) ?? undefined);
      setRows(rows as SkillRow[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    try {
      await fn();
      toast.success(done);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const dirOf = (row: SkillRow) => row.path.replace(/[/\\]SKILL\.md$/, "");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Skills"
        description="Instructions the agent loads when a task matches. Type / in the chat composer to invoke one; disabled skills are hidden everywhere."
      />
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Read from <code className="text-[11px]">.agents/skills</code> in the project and your
          home directory, plus Guild-installed skills.
        </p>
        <Button size="sm" variant="ghost" onClick={() => void reload()} title="Re-scan skill folders">
          <RefreshCw className="size-4" />
        </Button>
      </div>

      {rows === null ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Download as LucideIcon}
          title="No skills found"
          hint="Create a folder with a SKILL.md (name + description frontmatter) in .agents/skills, or install one from the Registry."
        />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          {rows.map((row) => (
            <div
              key={row.path}
              className="flex flex-col gap-2 border-b border-border/60 px-4 py-3 last:border-b-0 sm:flex-row sm:items-start sm:gap-4"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`font-medium ${row.disabled ? "text-muted-foreground" : ""}`}>
                    /{row.name}
                  </span>
                  <SourceBadge row={row} />
                  <span className="text-[11px] text-muted-foreground">
                    {SCOPE_LABELS[row.scope] ?? row.scope}
                  </span>
                  {row.disabled && (
                    <Badge variant="outline" className="text-muted-foreground">
                      disabled
                    </Badge>
                  )}
                </div>
                <p className="mt-0.5 line-clamp-2 text-sm text-muted-foreground">
                  {row.description}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() =>
                    void act(
                      `toggle-${row.path}`,
                      async () =>
                        setSkillDisabled(
                          daemonFs(rpcCall),
                          await daemonFs(rpcCall).scopes(),
                          row.path,
                          row.disabled,
                        ),
                      row.disabled ? "Skill enabled" : "Skill disabled",
                    )
                  }
                  title={row.disabled ? "Show in the agent index and composer" : "Hide from the agent index and composer"}
                >
                  {row.disabled ? (
                    <CircleCheck className="size-4" />
                  ) : (
                    <Ban className="size-4" />
                  )}
                  {row.disabled ? "Enable" : "Disable"}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => {
                    setPublishing(row);
                    setVersion(row.provenance?.version ?? "0.1.0");
                  }}
                  title="Publish this folder to the org registry"
                >
                  <Upload className="size-4" />
                  Publish
                </Button>
                {row.installed && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(
                        `rm-${row.path}`,
                        async () =>
                          rpcCall("registry.uninstall", {
                            slug: row.provenance?.slug ?? row.name,
                            global: row.scope === "user",
                            project_dir: (await resolveProjectDir()) ?? undefined,
                          }),
                        "Skill uninstalled",
                      )
                    }
                    title="Remove this registry-installed skill"
                  >
                    <Trash2 className="size-4" />
                    Uninstall
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={publishing !== null}
        onOpenChange={(open) => {
          if (!open) setPublishing(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogTitle>Publish /{publishing?.name ?? ""}</DialogTitle>
          <DialogDescription>
            Uploads this skill folder to the org registry as a new version. It goes to pending
            review; an admin approves it before others can install.
          </DialogDescription>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="skill-version">
              Version
            </label>
            <Input
              id="skill-version"
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              placeholder="0.1.0"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPublishing(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy !== null || !version.trim()}
              onClick={async () => {
                const row = publishing;
                if (!row) return;
                setPublishing(null);
                await act(
                  `pub-${row.path}`,
                  () =>
                    rpcCall("registry.publish", {
                      kind: "skill",
                      dir: dirOf(row),
                      version: version.trim(),
                    }),
                  `Published ${row.name} ${version.trim()} (pending review)`,
                );
              }}
            >
              Publish
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
