// "Choose project" picker (spec §5): search over projects, recently used
// projects first, a "No project" reset, and a "New project…" entry point
// into the create dialog.

import { SkeletonRows } from "@guild/ui/components/skeleton";
import { useMemo, useState } from "react";
import { Folder, FolderOpen, Plus, Search, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@guild/ui/components/dialog";
import { Input } from "@guild/ui/components/input";
import type { ChatSummary } from "../../lib/api/chats";
import type { Project } from "../../lib/api/projects";
import { filterProjects, recentProjects, type PickedProject } from "./projects";

export function ProjectPickerDialog({
  open,
  onOpenChange,
  projects,
  chats,
  current,
  onPick,
  onCreateProject,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: Project[] | null;
  chats: ChatSummary[] | null;
  /** The chat's current project (highlighted; enables the clear row). */
  current: PickedProject | null;
  onPick: (project: PickedProject | null) => void;
  /** Opens the create-project dialog. */
  onCreateProject: () => void;
}) {
  const [query, setQuery] = useState("");

  const { recents, matches } = useMemo(
    () => ({
      recents: recentProjects(chats, projects ?? []),
      matches: filterProjects(projects ?? [], query),
    }),
    [projects, chats, query],
  );

  const pick = (p: Project) => {
    onPick({ id: p.id, name: p.name, machine_label: p.machine_label });
    onOpenChange(false);
  };

  const recentIds = new Set(recents.map((p) => p.id));
  const rest = query.trim() ? matches : matches.filter((p) => !recentIds.has(p.id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Choose project</DialogTitle>
          <DialogDescription>
            The project's folder is where the agent reads and edits files.
          </DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search projects…"
              className="pl-8"
              autoFocus
            />
          </div>
          <div className="max-h-80 min-h-40 overflow-y-auto overscroll-contain">
            {projects === null && <SkeletonRows />}
            {projects !== null && (
              <div className="space-y-0.5">
                {current && (
                  <button
                    type="button"
                    className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
                    onClick={() => {
                      onPick(null);
                      onOpenChange(false);
                    }}
                  >
                    <X className="size-4 shrink-0" />
                    <span className="flex-1">No project</span>
                    <span className="text-xs text-muted-foreground/70">clears the binding</span>
                  </button>
                )}                {!query.trim() && recents.length > 0 && (
                  <p className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted-foreground">Recent</p>
                )}
                {recents.map((p) => (
                  <ProjectRow key={p.id} project={p} active={p.id === current?.id} onPick={pick} />
                ))}
                {!query.trim() && rest.length > 0 && recents.length > 0 && (
                  <p className="px-2.5 pb-1 pt-2 text-xs font-medium text-muted-foreground">All projects</p>
                )}
                {rest.map((p) => (
                  <ProjectRow key={p.id} project={p} active={p.id === current?.id} onPick={pick} />
                ))}
                {projects.length === 0 && !query.trim() && (
                  <p className="p-3 text-sm text-muted-foreground">
                    No projects yet — create one to give the agent a folder to work in.
                  </p>
                )}
                {query.trim() && matches.length === 0 && (
                  <p className="p-3 text-sm text-muted-foreground">No project matches “{query.trim()}”.</p>
                )}
                <button
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-accent"
                  onClick={() => {
                    onOpenChange(false);
                    onCreateProject();
                  }}
                >
                  <Plus className="size-4 shrink-0 text-muted-foreground" />
                  <span className="font-medium">New project…</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ProjectRow({
  project,
  active,
  onPick,
}: {
  project: Project;
  active: boolean;
  onPick: (p: Project) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onPick(project)}
      className={`flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm ${
        active ? "bg-accent text-accent-foreground" : "hover:bg-accent"
      }`}
    >
      {active ? (
        <FolderOpen className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <Folder className="size-4 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate font-medium">{project.name}</span>
      <span className="shrink-0 rounded-full bg-secondary px-1.5 py-px text-xs text-muted-foreground">
        {project.machine_label ?? project.machine_id}
      </span>
    </button>
  );
}
