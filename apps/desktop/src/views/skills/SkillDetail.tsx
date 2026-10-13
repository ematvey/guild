// Skill detail page (Skills tab → row click): description, owner badge,
// versions table, fork provenance, usage stats, and the action row —
// install / update pin / uninstall / edit (opens the skill editor) /
// fork / maintainer-approval toggle (owner or admin) / unpublish. Every
// action calls its skills API endpoint and refetches the detail.
// Navigation is the icon back button plus the "Skills / <slug>"
// breadcrumb in the header row.

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Lock } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@guild/ui/components/badge";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";
import { Skeleton } from "@guild/ui/components/skeleton";
import {
  skillsDetail,
  skillsFork,
  skillsGate,
  skillsInstall,
  skillsPin,
  skillsUninstall,
  skillsUnpublish,
  type SkillActionResult,
  type SkillDetail as SkillDetailData,
  type SkillMe,
} from "./skills-api";

/** True when the viewer's install sits behind the latest version. */
export function updateAvailable(detail: SkillDetailData): boolean {
  return (
    detail.my_install !== null &&
    detail.latest_version !== null &&
    detail.my_install.pinned_version !== detail.latest_version
  );
}

/** Owner-or-admin, as far as the desktop can tell: admins always manage;
 *  a user-owned skill matches when the owner label is the viewer's display
 *  name or email (the server's owner label is display name, falling back to
 *  email). Team-owned skills defer to the server (the buttons stay hidden;
 *  membership is not known client-side). */
export function canManageSkill(detail: SkillDetailData, me: SkillMe): boolean {
  if (me.role === "admin") return true;
  return (
    detail.owner?.kind === "user" &&
    ((me.displayName !== undefined && detail.owner.label === me.displayName) ||
      (me.email !== undefined && detail.owner.label === me.email))
  );
}

/** The visible action labels, in render order. The component renders one
 *  button per label, so this list is the single source of truth for what
 *  the actions row offers. */
export function detailActions(detail: SkillDetailData, me: SkillMe): string[] {
  if (detail.tombstoned) {
    // Unpublished: the provenance page stays readable; only cleanup remains.
    return detail.my_install !== null ? ["Uninstall"] : [];
  }
  const actions: string[] = [];
  if (detail.my_install === null) actions.push("Install");
  if (updateAvailable(detail)) actions.push("Update pin to latest");
  if (detail.my_install !== null) actions.push("Uninstall");
  if (detail.latest_version !== null) actions.push("Edit", "Fork");
  if (canManageSkill(detail, me)) {
    actions.push(detail.maintainer_gated ? "Remove approval" : "Require approval", "Unpublish");
  }
  return actions;
}

/** "v2 × 4 · v3 × 1", or the no-pins text. */
export function pinSummary(pinCounts: { version: string; count: number }[]): string {
  if (pinCounts.length === 0) return "No pins yet.";
  return pinCounts.map((p) => `${p.version} × ${p.count}`).join(" · ");
}

/** The read-analytics summary line (spec §3), or the no-reads text. */
export function readSummary(readStats: NonNullable<SkillDetailData["read_stats"]>): string {
  if (readStats.total === 0) return "No reads yet.";
  return `${readStats.total} read${readStats.total === 1 ? "" : "s"} in the last 30 days`;
}

/** Bar heights (px) for the 14-day reads series, normalized against the
 *  series' peak, bottoming out at the 2px minimum. */
export function readBars(series: Array<{ day: string; reads: number }>): number[] {
  const peak = Math.max(0, ...series.map((d) => d.reads));
  if (peak === 0) return series.map(() => 2);
  return series.map((d) => Math.max(2, Math.round((d.reads / peak) * 32)));
}

/** The POST /api/v1/skills body that forks this skill: from the viewer's
 *  pinned version when installed, else the latest. */
export function forkPayload(
  detail: SkillDetailData,
  newSlug: string,
): { slug: string; forked_from: string; from_version?: string } {
  const fromVersion = detail.my_install?.pinned_version ?? detail.latest_version ?? undefined;
  return { slug: newSlug, forked_from: detail.slug, from_version: fromVersion };
}

/** The detail page's lifecycle: loading (skeleton), missing (the call
 *  resolved null — 404 or network error), or ready (payload in hand). */
export type DetailLoadState = "loading" | "missing" | "ready";

export function detailLoadState(detail: SkillDetailData | null, loadFailed: boolean): DetailLoadState {
  if (detail !== null) return "ready";
  return loadFailed ? "missing" : "loading";
}

/** The header row shared by every detail state: icon back button plus
 *  the "Skills / <slug>" breadcrumb (the Skills segment navigates back
 *  too). */
function DetailHeader({ slug, onBack }: { slug: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-2 px-3 py-3">
      <Button variant="ghost" size="icon" onClick={onBack} aria-label="Back to skills">
        <ArrowLeft className="size-4" />
      </Button>
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5 text-sm">
        <button
          className="shrink-0 rounded-sm text-muted-foreground outline-none hover:text-foreground hover:underline"
          onClick={onBack}
        >
          Skills
        </button>
        <span className="shrink-0 text-muted-foreground">/</span>
        <span className="truncate font-medium">{slug}</span>
      </nav>
    </div>
  );
}

export interface SkillDetailProps {
  slug: string;
  me: SkillMe;
  onBack: () => void;
  /** Opens the skill editor for this slug. */
  onEdit?: (slug: string) => void;
  /** Navigates to another skill's detail (used after a successful fork). */
  onOpenSkill?: (slug: string) => void;
}

export function SkillDetail({ slug, me, onBack, onEdit, onOpenSkill }: SkillDetailProps) {
  const [detail, setDetail] = useState<SkillDetailData | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const [forkSlug, setForkSlug] = useState(`${slug}-fork`);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    skillsDetail(slug).then((d) => {
      if (live) {
        setLoadFailed(d === null);
        setDetail(d);
      }
    });
    return () => {
      live = false;
    };
  }, [slug, tick]);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  const run = useCallback(
    async (action: () => Promise<SkillActionResult>, okMsg: string, after?: () => void) => {
      setBusy(true);
      const res = await action();
      setBusy(false);
      if (res.ok) {
        toast.success(okMsg);
        after?.();
      } else {
        toast.error("Skill action failed", { description: res.message });
      }
      refetch();
    },
    [refetch],
  );

  if (detailLoadState(detail, loadFailed) === "missing") {
    return (
      <div className="flex min-h-0 w-full flex-1 flex-col">
        <DetailHeader slug={slug} onBack={onBack} />
        <div className="px-3 pb-3">
          <p className="text-sm text-muted-foreground">
            Skill not found — it may have been unpublished, or the request failed.
          </p>
          <Button variant="outline" size="sm" className="mt-2" onClick={onBack}>
            Back to skills
          </Button>
        </div>
      </div>
    );
  }

  if (detail === null) {
    return (
      <div className="flex min-h-0 w-full flex-1 flex-col">
        <DetailHeader slug={slug} onBack={onBack} />
        <div className="px-3 pb-3">
          <Skeleton className="mb-2 h-5 w-2/3 rounded-md" />
          <Skeleton className="mb-2 h-4 w-full rounded-md" />
          <Skeleton className="h-24 w-full rounded-md" />
        </div>
      </div>
    );
  }

  const actions = detailActions(detail, me);
  const forkDraft = forkPayload(detail, forkSlug.trim());

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <DetailHeader slug={detail.slug} onBack={onBack} />
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {detail.owner !== null && <Badge variant="secondary">{detail.owner.label}</Badge>}
          {detail.maintainer_gated && (
            <Badge variant="outline" className="gap-1 text-muted-foreground">
              <Lock className="size-3" /> approval required
            </Badge>
          )}
          {detail.tombstoned && <Badge variant="destructive">unpublished</Badge>}
        </div>
        {detail.maintainer_gated && (
          <p className="mb-2 rounded-md border border-border bg-muted/50 px-2.5 py-2 text-sm text-muted-foreground">
            Members can browse and fork this skill, but installing it needs maintainer sign-off —
            the owner or an admin approves.
          </p>
        )}
        {detail.description !== "" && <p className="mb-2 text-sm">{detail.description}</p>}
        {detail.forked_from !== null && (
          <p className="mb-2 text-sm text-muted-foreground">Forked from {detail.forked_from}</p>
        )}
        <p className="mb-2 text-sm text-muted-foreground">
          {detail.installs} install{detail.installs === 1 ? "" : "s"} · {pinSummary(detail.pin_counts)}
        </p>
        {detail.read_stats != null && (
          <div className="mb-3">
            <p className="text-sm text-muted-foreground">{readSummary(detail.read_stats)}</p>
            {detail.read_stats.series.length > 0 && (
              <div
                className="mt-1 flex h-8 items-end gap-0.5"
                aria-label="Reads per day, last 14 days"
              >
                {readBars(detail.read_stats.series).map((height, i) => (
                  <div
                    key={detail.read_stats!.series[i]!.day}
                    title={`${detail.read_stats!.series[i]!.day}: ${detail.read_stats!.series[i]!.reads}`}
                    className="w-2 rounded-sm bg-primary/40"
                    style={{ height: `${height}px` }}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        <h3 className="mb-1 text-sm font-medium">Versions</h3>
        <table className="mb-3 w-full text-sm">
          <thead>
            <tr className="text-left text-muted-foreground">
              <th className="py-1 pr-2 font-normal">Version</th>
              <th className="py-1 pr-2 font-normal">Published</th>
              <th className="py-1 font-normal">Publisher</th>
            </tr>
          </thead>
          <tbody>
            {detail.versions.map((v) => (
              <tr key={v.version} className="border-t border-border">
                <td className="py-1 pr-2">{v.version}</td>
                <td className="py-1 pr-2 text-muted-foreground">{v.published_at}</td>
                <td className="py-1 text-muted-foreground">{v.publisher ?? "—"}</td>
              </tr>
            ))}
            {detail.versions.length === 0 && (
              <tr>
                <td colSpan={3} className="py-1 text-muted-foreground">
                  No versions.
                </td>
              </tr>
            )}
          </tbody>
        </table>

        {actions.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-1.5">
            {actions.map((label) =>
              label === "Install" ? (
                <Button
                  key={label}
                  size="sm"
                  disabled={busy || detail.latest_version === null}
                  onClick={() => void run(() => skillsInstall(detail.slug), `Installed ${detail.slug}`)}
                >
                  {label}
                </Button>
              ) : label === "Update pin to latest" ? (
                <Button
                  key={label}
                  size="sm"
                  disabled={busy || detail.latest_version === null}
                  onClick={() =>
                    void run(
                      () => skillsPin(detail.slug, detail.latest_version as string),
                      `Pinned ${detail.slug} at ${detail.latest_version}`,
                    )
                  }
                >
                  {label}
                </Button>
              ) : label === "Uninstall" ? (
                <Button
                  key={label}
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void run(() => skillsUninstall(detail.slug), `Uninstalled ${detail.slug}`)}
                >
                  {label}
                </Button>
              ) : label === "Edit" ? (
                <Button
                  key={label}
                  variant="outline"
                  size="sm"
                  disabled={onEdit === undefined}
                  title={onEdit === undefined ? "Editor not available yet" : undefined}
                  onClick={() => onEdit?.(detail.slug)}
                >
                  {label}
                </Button>
              ) : label === "Fork" ? (
                <Button
                  key={label}
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    setForkSlug(`${detail.slug}-fork`);
                    setForkOpen(true);
                  }}
                >
                  {label}
                </Button>
              ) : label === "Require approval" || label === "Remove approval" ? (
                <Button
                  key={label}
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => skillsGate(detail.slug, !detail.maintainer_gated),
                      detail.maintainer_gated ? "Approval removed" : "Approval required",
                    )
                  }
                >
                  {label}
                </Button>
              ) : (
                <Button
                  key={label}
                  variant={confirmUnpublish ? "destructive" : "outline"}
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    if (!confirmUnpublish) {
                      setConfirmUnpublish(true);
                      return;
                    }
                    setConfirmUnpublish(false);
                    void run(() => skillsUnpublish(detail.slug), `Unpublished ${detail.slug}`, onBack);
                  }}
                >
                  {confirmUnpublish ? "Confirm unpublish" : label}
                </Button>
              ),
            )}
          </div>
        )}

        {forkOpen && (
          <div className="mb-3 rounded-md border border-border p-2">
            <p className="mb-1.5 text-sm text-muted-foreground">
              Fork {detail.slug}
              {forkDraft.from_version !== undefined ? ` at ${forkDraft.from_version}` : ""} into:
            </p>
            <div className="flex gap-1.5">
              <Input
                value={forkSlug}
                placeholder="new-slug"
                aria-label="Fork slug"
                onChange={(e) => setForkSlug(e.target.value)}
              />
              <Button
                size="sm"
                disabled={busy || forkSlug.trim() === "" || forkSlug.trim() === detail.slug}
                onClick={() =>
                  void run(() => skillsFork(forkDraft), `Forked ${detail.slug} as ${forkSlug.trim()}`, () =>
                    onOpenSkill?.(forkSlug.trim()),
                  )
                }
              >
                Fork
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setForkOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
