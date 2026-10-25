// Skill detail page (Skills tab → row click): prototype layout — slim top
// bar (back icon + "Skills › slug" breadcrumb + the action row), then a
// 56rem column with the title block (slug, badges, description, owner),
// the gated-install notice, and three sections: Files (bundle file tree +
// viewer from GET /skills/:slug/source), Versions (full-width table with
// sha prefix, pin counts and per-row Pin actions) and Insights (stat cards
// including the reads sparkline). Every action calls its skills API
// endpoint and refetches the detail. Navigation is the icon back button
// plus the breadcrumb in the top bar.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, File, Folder, Info, Lock } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { Badge } from "@guild/ui/components/badge";
import { Avatar } from "@guild/ui/components/avatar";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";
import { Skeleton, SkeletonText } from "@guild/ui/components/skeleton";
import {
  skillsDetail,
  skillsFork,
  skillsGate,
  skillsInstall,
  skillsPin,
  skillsSource,
  skillsUninstall,
  skillsUnpublish,
  type SkillActionResult,
  type SkillDetail as SkillDetailData,
  type SkillMe,
  type SkillSourceFile,
} from "./skills-api";
import { MD_CLASS, MD_TABLE_CLASS, mdComponents } from "../markdown";

/** SKILL.md body without the leading YAML frontmatter block: the detail
 * page header already shows name/description, so the preview starts at
 * the markdown content. Files without frontmatter return unchanged. */
export function skillMdPreviewBody(skillMd: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(skillMd);
  return match === null ? skillMd : skillMd.slice(match[0].length);
}

/** True when the viewer's install sits behind the latest version. */
export function updateAvailable(detail: SkillDetailData): boolean {
  return (
    detail.my_install !== null &&
    detail.my_install.pinned_version !== null &&
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

/** Who can publish updates, derived from the gate flag plus the owner kind
 *  (the server's publish gate: gated slugs accept pushes from the owner,
 *  the owning team, and admins — spec §1.2). "anyone" = gate off. */
export function editAccess(detail: Pick<SkillDetailData, "maintainer_gated" | "owner">): "anyone" | "team" | "owner" {
  if (!detail.maintainer_gated) return "anyone";
  return detail.owner?.kind === "team" ? "team" : "owner";
}

/** The user-facing label for an access level. Team-owned skills carry the
 *  team name: "Team Platform can edit". */
export function editAccessLabel(access: "anyone" | "team" | "owner", ownerLabel?: string): string {
  if (access === "anyone") return "Anyone can edit";
  if (access === "team") return `Team ${ownerLabel ?? ""} can edit`.trim();
  return "Owner can edit";
}

/** The visible action labels, in render order (the top bar's action row).
 *  The component maps each label to its button variant, so this list is
 *  the single source of truth for what the actions row offers. */
export function detailActions(detail: SkillDetailData, me: SkillMe): string[] {
  if (detail.tombstoned) {
    // Unpublished: the provenance page stays readable; only cleanup remains.
    return detail.my_install !== null ? ["Uninstall"] : [];
  }
  const actions: string[] = [];
  if (detail.my_install === null) actions.push("Install");
  if (updateAvailable(detail)) actions.push("Update pin to latest");
  if (detail.my_install !== null) actions.push("Uninstall");
  if (detail.latest_version !== null) actions.push("Fork", "Edit");
  if (canManageSkill(detail, me)) {
    actions.push(detail.maintainer_gated ? "Allow anyone to edit" : "Restrict editing", "Unpublish");
  }
  return actions;
}

/** The button variant an action label renders as (prototype: primary for
 *  install/pin, outline for the rest, ghost+destructive text for
 *  unpublish). */
export function actionVariant(label: string): "default" | "outline" | "ghost" {
  if (label === "Install" || label === "Update pin to latest") return "default";
  if (label === "Unpublish") return "ghost";
  return "outline";
}

/** 12-character bundle sha prefix for the versions table's Bundle cell,
 *  "—" when the version carries no sha. */
export function shaPrefix(sha: string | null): string {
  return sha === null || sha === "" ? "—" : sha.slice(0, 12);
}

/** True when a bundle file renders as markdown rather than raw text. */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/** The file list the detail page renders from the source manifest: SKILL.md
 *  first (its body ships inline), then the bundle's extra files in path
 *  order. manifest.json is bundle metadata — never listed. */
export function bundleFilePaths(source: {
  skill_md: string;
  files: Array<{ path: string; size?: number; sha256?: string }>;
}): string[] {
  return [
    "SKILL.md",
    ...source.files
      .map((f) => f.path)
      .filter((p) => p !== "SKILL.md" && p !== "manifest.json")
      .sort(),
  ];
}

/** One node of the file tree the Files section renders. */
export interface FileTreeNode {
  name: string;
  /** File path, or the directory's path prefix (files under it). */
  path: string;
  kind: "dir" | "file";
  children: FileTreeNode[];
}

/** Nested file tree from flat bundle paths: directories before files,
 *  alphabetical within each group. */
export function buildFileTree(paths: string[]): FileTreeNode[] {
  const root: FileTreeNode = { name: "", path: "", kind: "dir", children: [] };
  for (const path of [...paths].sort()) {
    const parts = path.split("/");
    let node = root;
    parts.forEach((part, i) => {
      const kind = i === parts.length - 1 ? "file" : "dir";
      const nodePath = parts.slice(0, i + 1).join("/");
      let child = node.children.find((c) => c.name === part && c.kind === kind);
      if (child === undefined) {
        child = { name: part, path: nodePath, kind, children: [] };
        node.children.push(child);
      }
      node = child;
    });
  }
  const sortNode = (n: FileTreeNode): void => {
    n.children.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1,
    );
    n.children.forEach(sortNode);
  };
  sortNode(root);
  return root.children;
}

/** "Oct 13, 2026" + a "3d ago"-style relative label for a version's publish
 *  timestamp (the versions table's Published cell). */
export function publishedLabel(iso: string): { date: string; rel: string } {
  const d = new Date(iso);
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  const rel =
    days < 1 ? "today" : days < 2 ? "yesterday" : days < 30 ? `${days}d ago` : `${Math.round(days / 30)}mo ago`;
  return { date, rel };
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

/** SVG rect geometry (x/y/w/h on a 260×44 viewBox) for the reads
 *  sparkline: bars normalized against the series' peak, bottoming out at
 *  the 2px minimum. */
export function sparkRects(
  series: Array<{ day: string; reads: number }>,
): Array<{ x: number; y: number; w: number; h: number }> {
  const W = 260;
  const H = 44;
  if (series.length === 0) return [];
  const peak = Math.max(1, ...series.map((d) => d.reads));
  const bw = W / series.length;
  return series.map((d, i) => {
    const h = Math.max(2, (d.reads / peak) * (H - 4));
    return {
      x: Number((i * bw + 1).toFixed(1)),
      y: Number((H - h).toFixed(1)),
      w: Number((bw - 2).toFixed(1)),
      h: Number(h.toFixed(1)),
    };
  });
}

/** Bar heights (px) for the 14-day reads series, normalized against the
 *  series' peak, bottoming out at the 2px minimum. */
export function readBars(series: Array<{ day: string; reads: number }>): number[] {
  return sparkRects(series).map((r) => r.h);
}

/** First two characters of a label, uppercased — the initials avatar chip
 *  (the detail page's owner line and versions table). */
export function avatarChip(label: string): string {
  return label.slice(0, 2).toUpperCase();
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

/** A section heading: label + muted "· N" count. */
function SectionHeading({ label, count }: { label: string; count?: number }) {
  return (
    <h2 className="mb-2 mt-[22px] text-sm font-semibold">
      {label}
      {count !== undefined && <span className="font-normal text-muted-foreground"> · {count}</span>}
    </h2>
  );
}

/** The slim top bar shared by every detail state: the "Skills › slug"
 *  breadcrumb (the Skills segment navigates back), and the action row at
 *  the right edge. */
function DetailHeader({ slug, onBack, actions }: { slug: string; onBack: () => void; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2.5 border-b border-border bg-background px-5 py-2.5">
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1 text-sm">
        <button
          className="shrink-0 rounded-sm text-muted-foreground outline-none hover:text-foreground"
          onClick={onBack}
        >
          Skills
        </button>
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-semibold">{slug}</span>
      </nav>
      <div className="flex-1" />
      {actions !== undefined && (
        <div className="flex flex-wrap items-center justify-end gap-2">{actions}</div>
      )}
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
  const [source, setSource] = useState<{
    version: string;
    skill_md: string;
    files: SkillSourceFile[];
  } | null>(null);
  const [sourceLoading, setSourceLoading] = useState(true);
  const [selectedFile, setSelectedFile] = useState("SKILL.md");
  const [collapsedDirs, setCollapsedDirs] = useState<ReadonlySet<string>>(new Set());
  const [rawSkillMd, setRawSkillMd] = useState(false);
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

  // The Files section reads the bundle manifest (SKILL.md body + extra
  // file paths) once the detail is in hand; refetches reload it too.
  useEffect(() => {
    if (detail === null) return;
    let live = true;
    setSource(null);
    setSourceLoading(true);
    skillsSource(detail.slug).then((s) => {
      if (live) { setSource(s); setSourceLoading(false); }
    }).catch(() => {
      if (live) setSourceLoading(false);
    });
    return () => {
      live = false;
    };
  }, [detail === null ? null : detail.slug, tick]);

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
        <div className="px-5 pb-3">
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
        <div className="mx-auto w-full max-w-[56rem] px-5 pt-4 pb-3">
          <Skeleton className="mb-2 h-6 w-2/3 rounded-lg" />
          <Skeleton className="mb-2 h-4 w-full rounded-md" />
          <SkeletonText lines={5} className="pt-3" />
        </div>
      </div>
    );
  }

  const actions = detailActions(detail, me);
  const forkDraft = forkPayload(detail, forkSlug.trim());
  const files = source === null ? null : bundleFilePaths(source);
  const currentPath = files !== null && files.includes(selectedFile) ? selectedFile : "SKILL.md";
  const tree = files === null ? [] : buildFileTree(files);
  const fileCount = files?.length;

  const renderTree = (nodes: FileTreeNode[], depth: number): ReactNode =>
    nodes.map((node) =>
      node.kind === "dir" ? (
        <div key={node.path}>
          <button
            type="button"
            aria-expanded={!collapsedDirs.has(node.path)}
            onClick={() =>
              setCollapsedDirs((prev) => {
                const next = new Set(prev);
                if (next.has(node.path)) next.delete(node.path);
                else next.add(node.path);
                return next;
              })
            }
            className="flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm text-muted-foreground outline-none hover:bg-accent"
            style={{ paddingLeft: `${8 + depth * 14}px` }}
          >
            {collapsedDirs.has(node.path) ? (
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
            ) : (
              <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
            )}
            <Folder className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{node.name}/</span>
          </button>
          {collapsedDirs.has(node.path) ? null : renderTree(node.children, depth + 1)}
        </div>
      ) : (
        <button
          key={node.path}
          aria-current={currentPath === node.path ? "true" : undefined}
          onClick={() => setSelectedFile(node.path)}
          style={{ paddingLeft: `${8 + depth * 14}px` }}
          className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm outline-none hover:bg-accent ${
            currentPath === node.path ? "bg-secondary" : ""
          }`}
        >
          <File className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{node.name}</span>
        </button>
      ),
    );

  const selectedSourceFile = source?.files.find((f) => f.path === currentPath);
  const viewerMeta =
    currentPath === "SKILL.md"
      ? `${source?.skill_md.split("\n").length ?? 0} lines`
      : `${selectedSourceFile?.size ?? 0} bytes`;
  const extraBody = selectedSourceFile?.content ?? null;
  const viewerBody =
    sourceLoading ? <SkeletonText lines={6} className="p-4" /> : source === null ? (
      <p className="p-10 text-center text-sm text-muted-foreground">
        File contents unavailable — the bundle manifest could not be loaded.
      </p>
    ) : currentPath !== "SKILL.md" && extraBody === null ? (
      <p className="p-10 text-center text-sm text-muted-foreground">
        No text preview — this file is binary or larger than 256 KiB. Download the bundle to read it.
      </p>
    ) : currentPath !== "SKILL.md" && isMarkdownPath(currentPath) ? (
      <div className={`px-4 py-3 text-sm leading-[1.6] text-foreground ${MD_CLASS} ${MD_TABLE_CLASS}`}>
        <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {extraBody!}
        </Markdown>
      </div>
    ) : currentPath !== "SKILL.md" ? (
      <pre className="whitespace-pre-wrap px-3.5 py-3 font-mono text-xs leading-[1.55] text-foreground">
        {extraBody}
      </pre>
    ) : !rawSkillMd ? (
      <div className={`px-4 py-3 text-sm leading-[1.6] text-foreground ${MD_CLASS} ${MD_TABLE_CLASS}`}>
        <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
          {skillMdPreviewBody(source.skill_md)}
        </Markdown>
      </div>
    ) : (
      <pre className="whitespace-pre-wrap px-3.5 py-3 font-mono text-xs leading-[1.55] text-foreground">
        {source.skill_md}
      </pre>
    );
  const viewer = (
    <div className="max-h-[55vh] min-w-0 flex-1 overflow-y-auto rounded-lg border border-border bg-card">
      <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-card px-3.5 py-2 text-xs font-medium text-muted-foreground">
        <span className="truncate">{currentPath}</span>
        <span className="flex-1" />
        {currentPath === "SKILL.md" && (
          <button
            type="button"
            onClick={() => setRawSkillMd((v) => !v)}
            className="shrink-0 rounded px-1.5 py-0.5 text-xs outline-none hover:bg-accent"
          >
            {rawSkillMd ? "Preview" : "Raw"}
          </button>
        )}        <span className="shrink-0 tabular-nums">{sourceLoading ? <Skeleton className="h-3 w-12" /> : source === null ? "" : viewerMeta}</span>
      </div>
      {viewerBody}
    </div>
  );

  const actionButtons = (
    <>
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
        ) : label === "Restrict editing" || label === "Allow anyone to edit" ? (
          <Button
            key={label}
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() =>
              void run(
                () => skillsGate(detail.slug, !detail.maintainer_gated),
                detail.maintainer_gated
                  ? "Editing opened to anyone"
                  : `Editing restricted — ${editAccessLabel(editAccess(detail), detail.owner?.label)} (plus admins)`,
              )
            }
          >
            <Lock className="size-3" />
            {label}
          </Button>
        ) : (
          <Button
            key={label}
            variant={confirmUnpublish ? "destructive" : "ghost"}
            size="sm"
            className={confirmUnpublish ? undefined : "text-destructive hover:bg-destructive/10 hover:text-destructive"}
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
    </>
  );

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <DetailHeader slug={detail.slug} onBack={onBack} actions={actionButtons} />
      <div className="min-h-0 flex-1 overflow-y-auto" data-scrollable>
        <div className="mx-auto w-full max-w-[56rem] px-5 pt-4 pb-12">
          {/* title block */}
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-xl font-semibold leading-tight">{detail.slug}</h1>
            {detail.maintainer_gated && (
              <Badge variant="secondary" className="gap-1">
                <Lock className="size-3" /> {editAccessLabel(editAccess(detail), detail.owner?.label)}
              </Badge>
            )}
            {detail.forked_from !== null && (
              <Badge variant="outline" className="gap-1 text-muted-foreground">
                fork of{" "}
                <button
                  className="font-medium outline-none underline-offset-2 hover:underline"
                  onClick={() => onOpenSkill?.(detail.forked_from as string)}
                >
                  {detail.forked_from}
                </button>
              </Badge>
            )}
            {detail.my_install !== null && (
              <Badge variant="outline" className="text-muted-foreground">
                installed {detail.my_install.pinned_version ?? "latest"}
              </Badge>
            )}
            {detail.tombstoned && <Badge variant="destructive">unpublished</Badge>}
          </div>
          {detail.description !== "" && (
            <p className="mt-1.5 text-sm text-muted-foreground">{detail.description}</p>
          )}
          {detail.owner !== null && (
            <p className="mt-2 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
              owned by
              <Avatar
                src={detail.owner.avatar_url}
                alt={detail.owner.label}
                fallback={avatarChip(detail.owner.label)}
                className="size-5 border border-border"
                fallbackClassName="bg-secondary text-3xs font-semibold text-foreground"
              />
              <span className="font-medium text-foreground">{detail.owner.label}</span>
              {detail.owner.kind === "team" && <span>(team)</span>}
            </p>
          )}

          {/* publish-gate notice */}
          {detail.maintainer_gated && (
            <div className="mt-3.5 flex items-start gap-2.5 rounded-lg border border-border bg-secondary px-3.5 py-2.5 text-sm text-secondary-foreground">
              <Info className="mt-0.5 size-[15px] shrink-0 text-muted-foreground" />
              <span>
                <span className="font-semibold">{editAccessLabel(editAccess(detail), detail.owner?.label)}.</span> Anyone in the org can
                browse, install, and fork this skill — but publishing updates is limited to{" "}
                {detail.owner?.kind === "team" ? `the ${detail.owner.label} team` : `the owner (${detail.owner?.label ?? "unknown"})`} and org admins.
              </span>
            </div>
          )}

          {/* Files: bundle file tree + inline viewer */}
          <SectionHeading label="Files" count={fileCount} />
          {files !== null && files.length > 1 ? (
            <div className="flex items-start gap-3.5">
              <div className="max-h-[55vh] w-[230px] shrink-0 overflow-y-auto rounded-lg border border-border bg-card p-1.5">
                {renderTree(tree, 0)}
              </div>
              {viewer}
            </div>
          ) : (
            viewer
          )}

          {/* Versions: full-width table */}
          <SectionHeading label="Versions" count={detail.versions.length} />
          <div className="overflow-x-auto rounded-lg border border-border bg-card">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs font-medium text-muted-foreground">
                  <th className="border-b border-border px-2.5 py-1.5">Version</th>
                  <th className="border-b border-border px-2.5 py-1.5">Published</th>
                  <th className="border-b border-border px-2.5 py-1.5">By</th>
                  <th className="border-b border-border px-2.5 py-1.5">Bundle</th>
                  <th className="border-b border-border px-2.5 py-1.5 text-right">Pins</th>
                  <th className="border-b border-border px-2.5 py-1.5">
                    <span className="sr-only">Row actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.versions.map((v) => {
                  const label = publishedLabel(v.published_at);
                  const pinCount = detail.pin_counts.find((p) => p.version === v.version)?.count ?? 0;
                  const isMyPin = detail.my_install?.pinned_version === v.version;
                  return (
                    <tr key={v.version} className="border-b border-border last:border-b-0">
                      <td className="px-2.5 py-2 font-semibold">{v.version}</td>
                      <td className="px-2.5 py-2">
                        {label.date}{" "}
                        <span className="text-muted-foreground">({label.rel})</span>
                      </td>
                      <td className="px-2.5 py-2 text-muted-foreground">
                        {v.publisher !== null && v.publisher !== "" ? (
                          <span className="flex items-center gap-1.5">
                            <Avatar
                              fallback={avatarChip(v.publisher)}
                              className="size-5 border border-border"
                              fallbackClassName="bg-secondary text-3xs font-semibold text-foreground"
                            />
                            <span className="truncate">{v.publisher}</span>
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td
                        className="px-2.5 py-2 text-2xs text-muted-foreground"
                        title={v.bundle_sha256 ?? undefined}
                      >
                        {shaPrefix(v.bundle_sha256)}
                      </td>
                      <td className="px-2.5 py-2 text-right text-muted-foreground tabular-nums">
                        {pinCount}
                      </td>
                      <td className="whitespace-nowrap px-2.5 py-2 text-right">
                        {isMyPin && (
                          <Badge variant="outline" className="text-muted-foreground">
                            your pin
                          </Badge>
                        )}
                        {detail.latest_version !== null && v.version !== detail.latest_version && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="ml-1.5 h-[26px] px-2 text-xs"
                            disabled={busy}
                            aria-label={`Pin ${detail.slug} at ${v.version}`}
                            onClick={() =>
                              void run(
                                () => skillsPin(detail.slug, v.version),
                                `Pinned ${detail.slug} at ${v.version}`,
                              )
                            }
                          >
                            Pin
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
                {detail.versions.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-2.5 py-2 text-muted-foreground">
                      No versions.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Insights: stat cards + the reads sparkline */}
          <SectionHeading label="Insights" />
          <div className="flex flex-wrap gap-3">
            <div className="flex min-w-[130px] flex-col gap-0.5 rounded-lg border border-border bg-card px-4 py-3">
              <span className="text-xl font-semibold">{detail.installs}</span>
              <span className="text-xs text-muted-foreground">installs</span>
            </div>
            <div className="flex min-w-[130px] flex-col gap-0.5 rounded-lg border border-border bg-card px-4 py-3">
              <span className="text-xl font-semibold">{detail.latest_version ?? "—"}</span>
              <span className="text-xs text-muted-foreground">latest</span>
            </div>
            <div className="flex min-w-[130px] flex-col gap-0.5 rounded-lg border border-border bg-card px-4 py-3">
              <span className="text-xl font-semibold">{detail.versions.length}</span>
              <span className="text-xs text-muted-foreground">versions</span>
            </div>
            <div className="min-w-[240px] flex-1 rounded-lg border border-border bg-card px-4 py-3">
              <span className="text-xl font-semibold">{detail.read_stats?.total ?? 0}</span>
              <span className="block text-xs text-muted-foreground">
                reads in the last 30 days
              </span>
              {detail.read_stats != null && detail.read_stats.series.length > 0 && (
                <svg
                  viewBox="0 0 260 44"
                  preserveAspectRatio="none"
                  className="mt-2 h-11 w-full"
                  role="img"
                  aria-label="Reads per day, last 14 days"
                >
                  {sparkRects(detail.read_stats.series).map((r, i) => (
                    <rect
                      key={detail.read_stats!.series[i]!.day}
                      x={r.x}
                      y={r.y}
                      width={r.w}
                      height={r.h}
                      rx="1.5"
                      className="fill-muted-foreground opacity-80"
                    />
                  ))}
                </svg>
              )}
            </div>
          </div>

          {forkOpen && (
            <div className="mt-3.5 rounded-lg border border-border bg-card p-2.5">
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
    </div>
  );
}
