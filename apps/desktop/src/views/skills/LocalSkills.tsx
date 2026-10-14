// Local machine tab (Skills panel, Tauri only): the machine's skill
// folders — provenance badges, enable/disable, publish to the org
// registry, uninstall (the body once lived in Settings → SkillsSection) —
// plus the signed-in user's org installs (GET /api/v1/skills/installs)
// with their pinned versions and Update-pin buttons. Machine-local state
// talks JSON-RPC to the app-server; org installs talk to the admin API.

import { useCallback, useEffect, useState } from "react";
import {
  Ban,
  CircleArrowUp,
  CircleCheck,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { rpcCall } from "../../transport";
import { resolveProjectDir } from "../settings/resolve-project-dir";
import { daemonFs, listSkills, setSkillDisabled } from "../../lib/context";
import {
  displayVersion,
  fetchInstalls,
  skillsList,
  skillsPin,
  skillsUninstall,
  type SkillInstall,
} from "./skills-api";
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
import { Spinner } from "@guild/ui/components/spinner";

/** One local skill row (the rpc list's entry, shaped for the UI). */
export interface LocalSkillRow {
  name: string;
  description: string;
  path: string;
  scope: string; // repo | user | legacy
  provenance: Record<string, string> | null;
  installed: boolean;
  published_by_me: boolean;
  disabled: boolean;
}

/** Which provenance badge a local row wears. */
export type SourceBadgeKind = "yours" | "installed" | "local";

export function sourceBadge(row: Pick<LocalSkillRow, "published_by_me" | "installed">): SourceBadgeKind {
  if (row.published_by_me) return "yours";
  if (row.installed) return "installed";
  return "local";
}

/** One org-install row's view model: the pin against the catalog's
 *  latest version. */
export interface InstallRowVM {
  slug: string;
  pinnedVersion: string;
  installedAt: string;
  /** True when the catalog knows a version other than the pin. */
  updateAvailable: boolean;
  /** The version an Update-pin click pins to (null when unknown). */
  pinTarget: string | null;
}

export function installRow(install: SkillInstall, latest: string | null): InstallRowVM {
  return {
    slug: install.slug,
    pinnedVersion: install.pinned_version,
    installedAt: install.installed_at,
    updateAvailable: latest !== null && install.pinned_version !== latest,
    pinTarget: latest,
  };
}

/** The enable/disable toggle's rpc wiring: flips skillsDisabled[row.path]
 *  in the app-server's settings.json (`disabled: true` on the row means
 *  the toggle enables it — the call passes the desired enabled state). */
export async function toggleDisabled(
  rpc: (method: string, params: any, timeoutMs?: number) => Promise<any>,
  row: Pick<LocalSkillRow, "path" | "disabled">,
): Promise<void> {
  const fs = daemonFs(rpc);
  await setSkillDisabled(fs, await fs.scopes(), row.path, row.disabled);
}

/** The uninstall wiring shared by the org-install rows and the local
 *  installed rows: server-first — the pin must go, or the next sync
 *  re-installs the folder a local-only delete removed — then a best-effort
 *  local folder removal so the panel doesn't wait for the machine-sync
 *  push. A server refusal (a dir copied in carrying provenance but no
 *  install record) falls back to the local-only removal. */
export async function uninstallSkill(
  slug: string,
  rpc: (method: string, params: any, timeoutMs?: number) => Promise<any>,
  localGlobal: boolean,
): Promise<void> {
  const res = await skillsUninstall(slug);
  const projectDir = (await resolveProjectDir()) ?? undefined;
  if (!res.ok) {
    await rpc("registry.uninstall", { slug, global: localGlobal, project_dir: projectDir });
    return;
  }
  try {
    await rpc("registry.uninstall", { slug, global: localGlobal, project_dir: projectDir });
  } catch {
    // The folder was never materialized here or is already gone — the
    // machine-sync push owns the rest of the fleet.
  }
}

function SourceBadge({ row }: { row: LocalSkillRow }) {
  const kind = sourceBadge(row);
  if (kind === "yours") {
    const v = row.provenance?.version;
    return (
      <Badge variant="outline" className="border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400">
        Yours{v ? ` · ${displayVersion(v)}` : ""}
      </Badge>
    );
  }
  if (kind === "installed") {
    const p = row.provenance;
    return (
      <Badge variant="outline" className="border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400">
        Installed{p?.version ? ` ${displayVersion(p.version)}` : ""}
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

export default function LocalSkills() {
  const [rows, setRows] = useState<LocalSkillRow[] | null>(null);
  const [installs, setInstalls] = useState<SkillInstall[] | null>(null);
  const [latest, setLatest] = useState<Map<string, string>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<LocalSkillRow | null>(null);
  const [version, setVersion] = useState("0.1.0");

  const reload = useCallback(async () => {
    setError(null);
    try {
      // Discovery moved client-side (lib/context.ts over the fs bridge);
      // org installs and the catalog come from the admin API.
      const fs = daemonFs(rpcCall);
      const scopes = await fs.scopes();
      const [localRows, orgInstalls, catalog] = await Promise.all([
        listSkills(fs, scopes, (await resolveProjectDir()) ?? undefined),
        fetchInstalls(),
        skillsList(),
      ]);
      setRows(localRows as LocalSkillRow[]);
      setInstalls(orgInstalls);
      const latestVersions = new Map<string, string>();
      for (const item of catalog ?? []) latestVersions.set(item.slug, item.latest_version);
      setLatest(latestVersions);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setRows([]);
      setInstalls(null);
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

  const dirOf = (row: LocalSkillRow) => row.path.replace(/[/\\]SKILL\.md$/, "");

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          Read from <code className="text-[11px]">.agents/skills</code> in the project and your
          home directory, plus Guild-installed skills.
        </p>
        <Button size="sm" variant="ghost" onClick={() => void reload()} title="Re-scan skill folders">
          <RefreshCw className="size-4" />
        </Button>
      </div>

      {installs !== null && installs.length > 0 && (
        <div className="mb-3">
          <p className="pb-1.5 text-xs font-medium text-muted-foreground">Org installs</p>
          <div className="overflow-hidden rounded-lg border border-border">
            {installs.map((install) => {
              const vm = installRow(install, latest.get(install.slug) ?? null);
              return (
                <div
                  key={vm.slug}
                  className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5 last:border-b-0"
                >
                  <div className="min-w-0">
                    <span className="font-medium">/{vm.slug}</span>
                    <p className="text-xs text-muted-foreground">
                      pinned at {vm.pinnedVersion}
                      {latest.has(vm.slug)
                        ? ` · latest ${displayVersion(latest.get(vm.slug) ?? "")}`
                        : ""}
                    </p>
                  </div>
                  {vm.updateAvailable && vm.pinTarget !== null && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="shrink-0"
                      disabled={busy !== null}
                      onClick={() =>
                        void act(
                          `pin-${vm.slug}`,
                          () => skillsPin(vm.slug, vm.pinTarget as string),
                          `Pinned ${vm.slug} at ${vm.pinTarget}`,
                        )
                      }
                      title={`Advance the pin to ${vm.pinTarget}`}
                    >
                      <CircleArrowUp className="size-4" />
                      Update pin
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="shrink-0 text-destructive hover:text-destructive"
                    disabled={busy !== null}
                    onClick={() =>
                      void act(
                        `rm-org-${vm.slug}`,
                        () => uninstallSkill(vm.slug, rpcCall, true),
                        `Uninstalled ${vm.slug}`,
                      )
                    }
                    title="Delete the install: the pin goes and every machine's copy is removed at its next sync (this machine's immediately)"
                  >
                    <Trash2 className="size-4" />
                    Uninstall
                  </Button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {rows === null ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : error ? (
        <p className="text-sm text-destructive">{error}</p>
      ) : rows.length === 0 ? null : (
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
                      () => toggleDisabled(rpcCall, row),
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
                        () =>
                          uninstallSkill(
                            row.provenance?.slug ?? row.name,
                            rpcCall,
                            row.scope === "user",
                          ),
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
