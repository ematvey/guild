// Skill editor (Skills tab → "New skill" or detail → Edit): slug (create
// only), owner selector (me or one of my teams), description, and the
// SKILL.md body with a Write/Preview toggle. Save publishes via the
// skills API (POST create / PUT next version); errors surface as sonner
// toasts and success hands the slug back for navigation to the detail
// page.

import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@guild/ui/components/select";
import { Skeleton } from "@guild/ui/components/skeleton";
import { Textarea } from "@guild/ui/components/textarea";
import { MD_CLASS, mdComponents } from "../markdown";
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
    void Promise.all([skillsDetail(slug ?? ""), skillsSource(slug ?? "")]).then(([detail, source]) => {
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
      setLoadFailed(false);
    });
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
          <Skeleton className="mb-2 h-9 w-full rounded-md" />
          <Skeleton className="mb-2 h-9 w-full rounded-md" />
          <Skeleton className="h-40 w-full rounded-md" />
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
  // Don't nag on a pristine empty slug field; the disabled Save carries it.
  const showSlugError = mode === "create" && form.slug !== "" && slugErr !== null;

  const save = async () => {
    setBusy(true);
    const res = await skillsSave(saveRequest(mode, form));
    setBusy(false);
    if (res.ok) {
      toast.success(res.slug !== undefined ? `Saved ${res.slug}` : "Skill saved");
      onSaved(res.slug ?? form.slug);
    } else {
      toast.error("Skill save failed", { description: res.message });
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
            onClick={() => void save()}
          >
            {busy ? "Saving…" : "Save"}
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
    </div>
  );
}
