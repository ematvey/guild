// Skill editor (Skills tab → "New skill" or detail → Edit): slug (create
// only), owner selector (me or one of my teams), description, and the
// bundle's files — a file tree over SKILL.md and the extra files, with a
// Write/Preview toggle for markdown. Publishing is guarded: the save action
// opens a review step showing the new slug/description and a per-file line
// diff against the latest published version, and only the explicit
// "Approve & publish" action calls the skills API (POST create / PUT next
// version). Errors surface as sonner toasts and success hands the slug back
// for navigation to the detail page.

import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Plus, Trash2 } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { Badge } from "@guild/ui/components/badge";
import { Button } from "@guild/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@guild/ui/components/dialog";
import { Input } from "@guild/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guild/ui/components/select";
import { SkeletonForm, SkeletonText } from "@guild/ui/components/skeleton";
import { Textarea } from "@guild/ui/components/textarea";
import { MD_CLASS, mdComponents } from "../markdown";
import { diffLines, type DiffLine } from "./skill-diff";
import { FileTree } from "./FileTree";
import { buildFileTree, filePathError, isMarkdownPath } from "./skill-files";
import {
  myTeams,
  skillsDetail,
  skillsSave,
  skillsSource,
  type EditorTeam,
} from "./skills-api";

/** Create publishes a fresh v1; edit publishes the next version of a
 *  fixed slug. */
export type EditorMode = "create" | "edit";

/** One extra bundle file in the draft (SKILL.md is `form.body`). */
export interface EditorFile {
  path: string;
  content: string;
}

export interface EditorForm {
  slug: string;
  description: string;
  body: string;
  /** Null = owned by the creating user ("Me"). */
  ownerTeamId: string | null;
  /** The bundle's extra files, SKILL.md excluded. */
  files: EditorFile[];
}

/** Slug validation mirroring the server's manifest rules (empty, ≤64
 *  chars, `[a-z0-9_-]`); null when the slug is publishable. */
export function slugError(slug: string): string | null {
  if (slug === "") return "Slug is required.";
  if (slug.length > 64) return "Slug is too long (max 64 characters).";
  if (![...slug].every((c) => /[a-z0-9_-]/.test(c))) {
    return "Slug may only contain lowercase letters, digits, - and _.";
  }
  return null;
}

/** POST /api/v1/skills body; owner_team_id only when a team is picked. */
export function createPayload(form: EditorForm): {
  slug: string;
  description: string;
  body: string;
  files: EditorFile[];
  owner_team_id?: string;
} {
  return form.ownerTeamId === null
    ? {
        slug: form.slug,
        description: form.description,
        body: form.body,
        files: form.files,
      }
    : {
        slug: form.slug,
        description: form.description,
        body: form.body,
        files: form.files,
        owner_team_id: form.ownerTeamId,
      };
}

/** PUT /api/v1/skills/:slug body. */
export function editPayload(form: EditorForm): {
  description: string;
  body: string;
  files: EditorFile[];
} {
  return { description: form.description, body: form.body, files: form.files };
}

/** The request each mode saves with: create POSTs the full payload,
 *  edit PUTs description + body + files at the fixed slug. */
export function saveRequest(mode: EditorMode, form: EditorForm): {
  method: "POST" | "PUT";
  path: string;
  body: ReturnType<typeof createPayload> | ReturnType<typeof editPayload>;
} {
  return mode === "create"
    ? { method: "POST", path: "/api/v1/skills", body: createPayload(form) }
    : { method: "PUT", path: `/api/v1/skills/${encodeURIComponent(form.slug)}`, body: editPayload(form) };
}

/** One owner selector option: Me first, then one per team. */
export interface OwnerOption {
  value: string;
  label: string;
}

export function ownerOptions(teams: EditorTeam[]): OwnerOption[] {
  return [{ value: "", label: "Me" }, ...teams.map((t) => ({ value: t.id, label: t.name }))];
}

/** Save enabled only when the form is publishable: create validates the
 *  slug (edit mode's slug is fixed), body and description are free-form. */
export function canSave(form: EditorForm, mode: EditorMode): boolean {
  return mode === "create" ? slugError(form.slug) === null : true;
}

/** The published content the edit-mode diff runs against (the manifest
 *  description plus the latest version's files). */
export interface ReviewBase {
  description: string;
  skill_md: string;
  /** The published bundle's extra files, SKILL.md excluded. */
  files: EditorFile[];
}

/** One changed file in the review step. */
export interface ReviewChange {
  path: string;
  status: "added" | "modified" | "deleted";
  diff: DiffLine[];
}

/** The review step's view model: per-file diffs plus whether anything
 *  actually changes (a description-only edit changes no file but still
 *  publishes a new version). */
export interface ReviewSummary {
  changes: ReviewChange[];
  descriptionChanged: boolean;
  hasChanges: boolean;
}

/** The draft's files as a path → content map, SKILL.md included. */
function draftFiles(form: EditorForm): Map<string, string> {
  return new Map([["SKILL.md", form.body], ...form.files.map((f) => [f.path, f.content] as const)]);
}

/** The published files as a path → content map, SKILL.md included. */
function baseFiles(base: ReviewBase): Map<string, string> {
  return new Map([["SKILL.md", base.skill_md], ...base.files.map((f) => [f.path, f.content] as const)]);
}

/** The publish guard's diff: create mode treats everything as added (full
 *  content diff); edit mode diffs each file against the latest published
 *  version, flagging deletions and a description-only change. */
export function reviewChanges(
  mode: EditorMode,
  form: EditorForm,
  base: ReviewBase | null,
): ReviewSummary {
  if (mode === "create" || base === null) {
    return {
      changes: [...draftFiles(form)].map(([path, content]) => ({
        path,
        status: "added" as const,
        diff: diffLines("", content),
      })),
      descriptionChanged: true,
      hasChanges: true,
    };
  }
  const published = baseFiles(base);
  const draft = draftFiles(form);
  const paths = [...new Set([...published.keys(), ...draft.keys()])].sort();
  const changes: ReviewChange[] = [];
  for (const path of paths) {
    const before = published.get(path);
    const after = draft.get(path);
    if (before === after) continue;
    if (after === undefined) {
      changes.push({ path, status: "deleted", diff: diffLines(before ?? "", "") });
    } else {
      changes.push({
        path,
        status: before === undefined ? "added" : "modified",
        diff: diffLines(before ?? "", after),
      });
    }
  }
  const descriptionChanged = form.description !== base.description;
  return {
    changes,
    descriptionChanged,
    hasChanges: changes.length > 0 || descriptionChanged,
  };
}

/** The body pane's two panes: the markdown textarea and its rendered
 *  read-only preview. */
export type EditorPane = "write" | "preview";

export interface SkillEditorProps {
  mode: EditorMode;
  /** Edit mode: the slug being edited (fixed, also the save target). */
  slug?: string;
  onBack: () => void;
  /** Success: navigate to the saved skill's detail page. */
  onSaved: (slug: string) => void;
}

export function SkillEditor({ mode, slug, onBack, onSaved }: SkillEditorProps) {
  const [form, setForm] = useState<EditorForm>({
    slug: "",
    description: "",
    body: "",
    ownerTeamId: null,
    files: [],
  });
  const [teams, setTeams] = useState<EditorTeam[] | null>(null);
  const [pane, setPane] = useState<EditorPane>("write");
  const [selectedPath, setSelectedPath] = useState("SKILL.md");
  const [newPath, setNewPath] = useState("");
  const [addingFile, setAddingFile] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  // Edit mode: the published content the review diff runs against; null
  // in create mode (everything counts as added).
  const [base, setBase] = useState<ReviewBase | null>(null);
  // Edit mode: null until the detail + source load, false when the skill
  // is gone (404 or network error).
  const [loadFailed, setLoadFailed] = useState<boolean | null>(mode === "create" ? false : null);
  // Published files the source endpoint returns without a text body
  // (binary, or over the inline cap): they cannot round-trip through this
  // editor, so a save is refused while they are present.
  const [unreadable, setUnreadable] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    if (mode === "create") {
      myTeams().then((t) => {
        if (live) setTeams(t ?? []);
      });
      return () => {
        live = false;
      };
    }
    void (async () => {
      const detail = await skillsDetail(slug ?? "");
      // The source request pins the version explicitly so the seeded files
      // and the review diff both run against the latest published content
      // (a pinned install must not silently select an older version).
      const source =
        detail === null ? null : await skillsSource(slug ?? "", detail.latest_version ?? undefined);
      if (!live) return;
      if (detail === null || source === null) {
        setLoadFailed(true);
        return;
      }
      const files = source.files
        .filter((f) => f.path !== "SKILL.md" && f.path !== "manifest.json" && f.content !== null)
        .map((f) => ({ path: f.path, content: f.content as string }));
      setForm({
        slug: detail.slug,
        description: detail.description,
        body: source.skill_md,
        ownerTeamId: null,
        files,
      });
      setUnreadable(
        source.files
          .filter((f) => f.path !== "SKILL.md" && f.path !== "manifest.json" && f.content === null)
          .map((f) => f.path),
      );
      setBase({ description: detail.description, skill_md: source.skill_md, files });
      setLoadFailed(false);
    })();
    return () => {
      live = false;
    };
  }, [mode, slug]);

  const paths = useMemo(
    () => ["SKILL.md", ...form.files.map((f) => f.path)],
    [form.files],
  );
  const tree = useMemo(() => buildFileTree(paths), [paths]);
  const currentPath = paths.includes(selectedPath) ? selectedPath : "SKILL.md";
  const currentFile = form.files.find((f) => f.path === currentPath);
  const currentContent = currentPath === "SKILL.md" ? form.body : (currentFile?.content ?? "");
  const markdown = isMarkdownPath(currentPath);

  const setContent = (value: string) =>
    setForm((f) =>
      currentPath === "SKILL.md"
        ? { ...f, body: value }
        : { ...f, files: f.files.map((file) => (file.path === currentPath ? { ...file, content: value } : file)) },
    );

  const addFile = () => {
    const path = newPath.trim();
    const problem = filePathError(path);
    if (problem !== null) {
      toast.error("Cannot add file", { description: problem });
      return;
    }
    if (paths.includes(path)) {
      toast.error("Cannot add file", { description: `${path} is already in the bundle.` });
      return;
    }
    setForm((f) => ({ ...f, files: [...f.files, { path, content: "" }] }));
    setSelectedPath(path);
    setNewPath("");
    setAddingFile(false);
    setPane("write");
  };

  const deleteFile = () => {
    if (currentPath === "SKILL.md") return;
    setForm((f) => ({ ...f, files: f.files.filter((file) => file.path !== currentPath) }));
    setSelectedPath("SKILL.md");
  };

  if (loadFailed === null) {
    return (
      <div className="flex min-h-0 w-full flex-1 flex-col">
        <div className="flex items-center gap-2 px-3 py-3">
          <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back to skills">
            <ArrowLeft className="size-4" />
          </Button>
          <span className="font-semibold">Edit skill</span>
        </div>
        <div className="px-3 pb-3">
          <SkeletonForm />
          <SkeletonText lines={5} className="pt-3" />
        </div>
      </div>
    );
  }

  if (loadFailed) {
    return (
      <div className="flex min-h-0 w-full flex-1 flex-col">
        <div className="flex items-center gap-2 px-3 py-3">
          <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back to skills">
            <ArrowLeft className="size-4" />
          </Button>
          <span className="truncate font-semibold">{slug}</span>
        </div>
        <div className="px-3 pb-3">
          <p className="text-sm text-muted-foreground">
            Skill not found, or its source could not be loaded.
          </p>
          <Button variant="outline" size="sm" className="mt-2" onClick={onBack}>
            Back to skills
          </Button>
        </div>
      </div>
    );
  }

  const slugErr = mode === "create" ? slugError(form.slug) : null;
  // Don't nag on a pristine empty slug field; the disabled review button
  // carries it.
  const showSlugError = mode === "create" && form.slug !== "" && slugErr !== null;

  const review = reviewChanges(mode, form, base);
  const blocked = unreadable.length > 0;

  // The API write lives here and nowhere else: the save button only opens
  // the review dialog, and the dialog's approve action calls this.
  const publish = async () => {
    setBusy(true);
    const res = await skillsSave(saveRequest(mode, form));
    setBusy(false);
    if (res.ok) {
      toast.success(res.slug !== undefined ? `Published ${res.slug}` : "Skill published");
      setReviewOpen(false);
      onSaved(res.slug ?? form.slug);
    } else {
      toast.error("Skill publish failed", { description: res.message });
    }
  };

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="flex items-center gap-2 px-3 py-3">
        <Button variant="ghost" size="sm" onClick={onBack} aria-label="Back to skills">
          <ArrowLeft className="size-4" />
        </Button>
        <span className="truncate font-semibold">{mode === "create" ? "New skill" : `Edit ${slug}`}</span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
        <div className="flex items-end gap-2">
          <label className="flex-1">
            <span className="mb-1 block text-sm text-muted-foreground">Slug</span>
            <Input
              value={form.slug}
              placeholder="my-skill"
              aria-label="Skill slug"
              disabled={mode === "edit" || busy}
              onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
            />
          </label>
          {/* Owner is create-only: the PUT edit endpoint keeps the owner. */}
          {mode === "create" && (
            <label className="w-36">
              <span className="mb-1 block text-sm text-muted-foreground">Owner</span>
              <Select
                value={form.ownerTeamId ?? ""}
                onValueChange={(v) => setForm((f) => ({ ...f, ownerTeamId: v === "" ? null : v }))}
                disabled={busy}
              >
                <SelectTrigger aria-label="Skill owner">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ownerOptions(teams ?? []).map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )}
        </div>
        {showSlugError && <p className="text-destructive">{slugErr}</p>}
        {mode === "create" && teams !== null && teams.length === 0 && (
          <p className="text-muted-foreground">You are not on any team; the skill will be owned by you.</p>
        )}
        <label>
          <span className="mb-1 block text-sm text-muted-foreground">Description</span>
          <Input
            value={form.description}
            placeholder="What this skill does"
            aria-label="Skill description"
            disabled={busy}
            onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          />
        </label>
        <div className="flex min-h-0 flex-1 items-start gap-3">
          <aside className="flex w-56 shrink-0 flex-col gap-1.5">
            <div
              className="max-h-[55vh] overflow-y-auto rounded-lg border border-border bg-card p-1.5"
              aria-label="Bundle files"
            >
              <FileTree nodes={tree} selected={currentPath} onSelect={setSelectedPath} />
            </div>
            {addingFile ? (
              <div className="flex flex-col gap-1">
                <Input
                  value={newPath}
                  placeholder="references/notes.md"
                  aria-label="New file path"
                  autoFocus
                  disabled={busy}
                  onChange={(e) => setNewPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") addFile();
                    if (e.key === "Escape") {
                      setAddingFile(false);
                      setNewPath("");
                    }
                  }}
                />
                <div className="flex gap-1">
                  <Button size="sm" disabled={busy} onClick={addFile}>
                    Add
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setAddingFile(false);
                      setNewPath("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => setAddingFile(true)}
              >
                <Plus className="size-3.5" />
                New file
              </Button>
            )}
            {currentPath !== "SKILL.md" && (
              <Button
                variant="ghost"
                size="sm"
                className="justify-start text-destructive"
                aria-label={`Delete ${currentPath}`}
                disabled={busy}
                onClick={deleteFile}
              >
                <Trash2 className="size-3.5" />
                Delete file
              </Button>
            )}
          </aside>
          <div className="flex min-h-0 flex-1 flex-col gap-2">
            <div className="flex items-center gap-1">
              <span className="truncate font-mono text-xs text-muted-foreground">{currentPath}</span>
              <span className="flex-1" />
              {markdown && (
                <>
                  {(
                    [
                      ["write", "Write"],
                      ["preview", "Preview"],
                    ] as const
                  ).map(([value, label]) => (
                    <Button
                      key={value}
                      variant={pane === value ? "secondary" : "ghost"}
                      size="sm"
                      aria-pressed={pane === value}
                      aria-label={`${label} pane`}
                      disabled={busy}
                      onClick={() => setPane(value)}
                    >
                      {label}
                    </Button>
                  ))}
                </>
              )}
              <Button
                size="sm"
                disabled={busy || blocked || !canSave(form, mode)}
                title={slugErr ?? (blocked ? "This skill has files the editor cannot read as text." : undefined)}
                onClick={() => setReviewOpen(true)}
              >
                Review & publish
              </Button>
            </div>
            {blocked && (
              <p className="rounded-md border border-border bg-secondary px-2.5 py-2 text-sm text-secondary-foreground">
                This skill has files the editor cannot read as text (binary, or over 256 KiB):{" "}
                <span className="font-mono">{unreadable.join(", ")}</span>. Publishing here would drop
                them, so the save is blocked.
              </p>
            )}
            {markdown && pane === "preview" ? (
              <div className={`min-h-64 flex-1 overflow-y-auto rounded-md border border-border p-3 text-sm ${MD_CLASS}`}>
                {currentContent.trim() === "" ? (
                  <p className="text-muted-foreground">Nothing to preview yet.</p>
                ) : (
                  <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                    {currentContent}
                  </Markdown>
                )}
              </div>
            ) : (
              <Textarea
                value={currentContent}
                placeholder={
                  currentPath === "SKILL.md"
                    ? "# Skill name\n\nMarkdown instructions for the agent."
                    : "File contents"
                }
                aria-label={`${currentPath} contents`}
                className="min-h-64 flex-1 font-mono text-sm"
                disabled={busy}
                onChange={(e) => setContent(e.target.value)}
              />
            )}
          </div>
        </div>
      </div>
      <ReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        mode={mode}
        slug={form.slug}
        description={form.description}
        baseVersion={mode === "edit" ? (base === null ? null : "latest") : null}
        review={review}
        busy={busy}
        onApprove={() => void publish()}
      />
    </div>
  );
}

/** Diff lines shown before the "… N more lines" note. */
const MAX_DIFF_LINES = 400;

function diffLineClass(type: DiffLine["type"]): string {
  switch (type) {
    case "add":
      return "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
    case "del":
      return "bg-destructive/10 text-destructive";
    case "ctx":
      return "text-muted-foreground";
  }
}

/** One changed file's review card: path + status badge over a capped,
 *  scrollable line diff (mono is file content, not UI text). */
function FileDiff({ change }: { change: ReviewChange }) {
  const shown = change.diff.slice(0, MAX_DIFF_LINES);
  const statusLabel =
    change.status === "added" ? "new file" : change.status === "deleted" ? "deleted" : "modified";
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-sm">
        <span className="font-medium">{change.path}</span>
        <Badge
          variant={change.status === "added" ? "secondary" : "outline"}
          className={change.status === "added" ? "" : "text-muted-foreground"}
        >
          {statusLabel}
        </Badge>
      </div>
      <div className="max-h-72 overflow-y-auto py-1 font-mono text-xs leading-relaxed" data-scrollable>
        {shown.map((line, i) => (
          <div key={i} className={`whitespace-pre-wrap px-3 ${diffLineClass(line.type)}`}>
            {line.type === "add" ? "+ " : line.type === "del" ? "- " : "  "}
            {line.text === "" ? "\u00A0" : line.text}
          </div>
        ))}
        {change.diff.length > shown.length && (
          <p className="px-3 py-1 text-muted-foreground">
            … {change.diff.length - shown.length} more lines
          </p>
        )}
      </div>
    </div>
  );
}

/** The publish guard's review step: the new skill's slug/description plus
 *  a per-file diff against the latest published version. "Approve &
 *  publish" is the only path to the API write; disabled with a note when
 *  the draft changes nothing. */
function ReviewDialog({
  open,
  onOpenChange,
  mode,
  slug,
  description,
  baseVersion,
  review,
  busy,
  onApprove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: EditorMode;
  slug: string;
  description: string;
  /** "latest" in edit mode once the base has loaded, null in create mode. */
  baseVersion: "latest" | null;
  review: ReviewSummary;
  busy: boolean;
  onApprove: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Review & publish</DialogTitle>
          <DialogDescription>
            {mode === "create"
              ? `Publishing creates ${slug || "the skill"} at v1 — nothing is written until you approve.`
              : `Publishing bumps ${slug} to the next version — nothing is written until you approve.`}
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto" data-scrollable>
          <div className="rounded-md border border-border px-2.5 py-2 text-sm">
            <p>
              <span className="text-muted-foreground">Slug: </span>
              <span className="font-medium">{slug || "—"}</span>
            </p>
            <p className="min-w-0">
              <span className="text-muted-foreground">Description: </span>
              {description.trim() === "" ? <span className="text-muted-foreground">—</span> : description}
            </p>
          </div>
          {review.changes.map((change) => (
            <FileDiff key={change.path} change={change} />
          ))}
          {!review.hasChanges && (
            <p className="text-sm text-muted-foreground">
              No changes against the published {baseVersion === "latest" ? "latest version" : "content"} —
              nothing to publish.
            </p>
          )}
          {review.hasChanges && review.changes.length === 0 && review.descriptionChanged && (
            <p className="text-sm text-muted-foreground">
              Only the description changes; no bundle file changes.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => onOpenChange(false)}>
            Back to edit
          </Button>
          <Button size="sm" disabled={busy || !review.hasChanges} onClick={onApprove}>
            {busy ? "Publishing…" : "Approve & publish"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
