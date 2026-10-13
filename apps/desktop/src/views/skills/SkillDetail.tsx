// Skill detail page (Skills tab → card click): description, owner badge,
// versions table, fork provenance, usage stats, and the action row —
// install / update pin / uninstall / edit (Task 13 wires the editor) /
// fork / maintainer-gate toggle (owner or admin) / unpublish. Every action
// calls its Task 3 endpoint and refetches the detail.

import { useCallback, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
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
    actions.push(detail.maintainer_gated ? "Remove gate" : "Gate", "Unpublish");
  }
  return actions;
}

/** "v2 × 4 · v3 × 1", or the no-pins text. */
export function pinSummary(pinCounts: { version: string; count: number }[]): string {
  if (pinCounts.length === 0) return "No pins yet.";
  return pinCounts.map((p) => `${p.version} × ${p.count}`).join(" · ");
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

export interface SkillDetailProps {
  slug: string;
  me: SkillMe;
  onBack: () => void;
  /** Task 13 wires the editor; absent until then the button is a disabled
   *  placeholder. */
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
        <div className="flex items-center gap-2 px-3 py-3">
          <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back to skills">
            <ArrowLeft className="size-4" />
          </Button>
          <span className="font-semibold">{slug}</span>
        </div>
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
        <div className="flex items-center gap-2 px-3 py-3">
          <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back to skills">
            <ArrowLeft className="size-4" />
          </Button>
          <span className="font-semibold">{slug}</span>
        </div>
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
      <div className="flex items-center gap-2 px-3 py-3">
        <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back to skills">
          <ArrowLeft className="size-4" />
        </Button>
        <span className="truncate font-semibold">{detail.slug}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {detail.owner !== null && <Badge variant="secondary">{detail.owner.label}</Badge>}
          {detail.maintainer_gated && <Badge variant="outline">gated</Badge>}
          {detail.tombstoned && <Badge variant="destructive">unpublished</Badge>}
        </div>
        {detail.description !== "" && <p className="mb-2 text-sm">{detail.description}</p>}
        {detail.forked_from !== null && (
          <p className="mb-2 text-sm text-muted-foreground">Forked from {detail.forked_from}</p>
        )}
        <p className="mb-2 text-sm text-muted-foreground">
          {detail.installs} install{detail.installs === 1 ? "" : "s"} · {pinSummary(detail.pin_counts)}
        </p>

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
              ) : label === "Gate" || label === "Remove gate" ? (
                <Button
                  key={label}
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => skillsGate(detail.slug, !detail.maintainer_gated),
                      detail.maintainer_gated ? "Gate removed" : "Skill gated",
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
