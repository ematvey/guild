// Skill editor (Skills tab → "New skill" or detail → Edit): slug (create
// only), owner selector (me or one of my teams), description, and the
// SKILL.md body with a Write/Preview toggle. Publishing is guarded: the
// save action opens a review step showing the new slug/description and a
// per-file line diff against the latest published version, and only the
// explicit "Approve & publish" action calls the skills API (POST create /
// PUT next version). Errors surface as sonner toasts and success hands
// the slug back for navigation to the detail page.

import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
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

export interface EditorForm {
  slug: string;
  description: string;
  body: string;
  /** Null = owned by the creating user ("Me"). */
  ownerTeamId: string | null;
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
  owner_team_id?: string;
} {
  return form.ownerTeamId === null
    ? { slug: form.slug, description: form.description, body: form.body }
    : { slug: form.slug, description: form.description, body: form.body, owner_team_id: form.ownerTeamId };
}

/** PUT /api/v1/skills/:slug body. */
export function editPayload(form: EditorForm): { description: string; body: string } {
  return { description: form.description, body: form.body };
}

/** The request each mode saves with: create POSTs the full payload,
 *  edit PUTs description + body at the fixed slug. */
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
 *  description plus the latest version's SKILL.md body). */
export interface ReviewBase {
  description: string;
  skill_md: string;
}

/** One changed file in the review step: the editor publishes a single
 *  SKILL.md, so path is always SKILL.md — added in create mode (full
 *  content diff), modified in edit mode. */
export interface ReviewChange {
  path: string;
  status: "added" | "modified";
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

/** The publish guard's diff: create mode treats everything as added
 *  (full content diff); edit mode diffs the body against the latest
 *  published version and flags a description-only change. */
export function reviewChanges(
  mode: EditorMode,
  form: EditorForm,
  base: ReviewBase | null,
): ReviewSummary {
  if (mode === "create" || base === null) {
    return {
      changes: [{ path: "SKILL.md", status: "added", diff: diffLines("", form.body) }],
      descriptionChanged: true,
      hasChanges: true,
    };
  }
  const bodyChanged = form.body !== base.skill_md;
  const descriptionChanged = form.description !== base.description;
  return {
    changes: bodyChanged
      ? [{ path: "SKILL.md", status: "modified", diff: diffLines(base.skill_md, form.body) }]
      : [],
    descriptionChanged,
    hasChanges: bodyChanged || descriptionChanged,
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
  });
  const [teams, setTeams] = useState<EditorTeam[] | null>(null);
  const [pane, setPane] = useState<EditorPane>("write");
  const [busy, setBusy] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  // Edit mode: the published content the review diff runs against; null
  // in create mode (everything counts as added).
  const [base, setBase] = useState<ReviewBase | null>(null);
  // Edit mode: null until the detail + source load, false when the skill
  // is gone (404 or network error).
  const [loadFailed, setLoadFailed] = useState<boolean | null>(mode === "create" ? false : null);

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
      // The source request pins the version explicitly so the seeded body
      // and the review diff both run against the latest published content
      // (a pinned install must not silently select an older version).
      const source =
        detail === null ? null : await skillsSource(slug ?? "", detail.latest_version ?? undefined);
      if (!live) return;
      if (detail === null || source === null) {
        setLoadFailed(true);
        return;
      }
      setForm({
        slug: detail.slug,
        description: detail.description,
        body: source.skill_md,
        ownerTeamId: null,
      });
      setBase({ description: detail.description, skill_md: source.skill_md });
      setLoadFailed(false);
    })();
    return () => {
      live = false;
    };
  }, [mode, slug]);

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
        <div className="flex items-center gap-1">
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
          <span className="flex-1" />
          <Button
            size="sm"
            disabled={busy || !canSave(form, mode)}
            title={slugErr ?? undefined}
            onClick={() => setReviewOpen(true)}
          >
            Review & publish
          </Button>
        </div>
        {pane === "write" ? (
          <Textarea
            value={form.body}
            placeholder={"# Skill name\n\nMarkdown instructions for the agent."}
            aria-label="SKILL.md body"
            className="min-h-64 flex-1 font-mono text-sm"
            disabled={busy}
            onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
          />
        ) : (
          <div className={`min-h-64 flex-1 rounded-md border border-border p-3 text-sm ${MD_CLASS}`}>
            {form.body.trim() === "" ? (
              <p className="text-muted-foreground">Nothing to preview yet.</p>
            ) : (
              <Markdown remarkPlugins={[remarkGfm]} components={mdComponents}>
                {form.body}
              </Markdown>
            )}
          </div>
        )}
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
  return (
    <div className="overflow-hidden rounded-md border border-border">
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-sm">
        <span className="font-medium">{change.path}</span>
        <Badge
          variant={change.status === "added" ? "secondary" : "outline"}
          className={change.status === "added" ? "" : "text-muted-foreground"}
        >
          {change.status === "added" ? "new file" : "modified"}
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
              Only the description changes; the SKILL.md body is unchanged.
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
