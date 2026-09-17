// Create-project dialog (spec §5): name + "Add a folder on <machine>".
// Folder sources for the local machine: a native folder dialog, or a WSL
// distro browsed in-app (the path specifier). Folders on other machines are
// listed but disabled — remote browsing is a follow-up.

import { useEffect, useState } from "react";
import { FolderOpen, HardDrive, Monitor, X as XIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@guild/ui/components/dialog";
import { Button } from "@guild/ui/components/button";
import { Input } from "@guild/ui/components/input";
import { Spinner } from "@guild/ui/components/spinner";
import { toast } from "sonner";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import {
  createProject,
  listWslDistros,
  type Distro,
  type MachineInfo,
  type Project,
} from "../../transport";
import { PathSpecifier } from "./PathSpecifier";

type View = { kind: "sources" } | { kind: "browse"; distro: string };

export function CreateProjectDialog({
  open,
  onOpenChange,
  machines,
  localMachineId,
  isTauri,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machines: MachineInfo[] | null;
  localMachineId: string;
  isTauri: boolean;
  /** Called with the created project (the caller selects it). */
  onCreated: (project: Project) => void;
}) {
  const [name, setName] = useState("");
  const [folder, setFolder] = useState<string | null>(null);
  const [view, setView] = useState<View>({ kind: "sources" });
  const [distros, setDistros] = useState<Distro[] | null>(null);
  const [busy, setBusy] = useState(false);

  const localMachine = machines?.find((m) => m.machine_id === localMachineId);
  const localLabel = localMachine?.name ?? "this computer";
  const otherMachines = machines?.filter((m) => m.machine_id !== localMachineId) ?? [];

  useEffect(() => {
    if (!open) {
      setName("");
      setFolder(null);
      setView({ kind: "sources" });
      setDistros(null);
      return;
    }
    if (isTauri) {
      void listWslDistros()
        .then(setDistros)
        .catch(() => setDistros([]));
    } else {
      setDistros([]);
    }
  }, [open, isTauri]);

  const create = async () => {
    if (!name.trim() || !folder) return;
    setBusy(true);
    try {
      const project = await createProject({
        name: name.trim(),
        folder,
        machine_id: localMachineId,
      });
      onCreated(project);
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const pickNativeFolder = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setFolder(picked);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-3rem)] max-w-[calc(100vw-2rem)] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New project</DialogTitle>
          <DialogDescription>
            A project is a named folder the agent works in; threads attach to it.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 min-w-0 flex-1 space-y-4">
          <div>
            <label htmlFor="project-name" className="mb-1 block text-sm font-medium">
              Name
            </label>
            <Input
              id="project-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-project"
              autoFocus
            />
          </div>

          {view.kind === "browse" ? (
            <div className="flex min-h-40 min-w-0 flex-1 flex-col gap-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">
                  Folder in <span className="font-mono">{view.distro}</span>
                </p>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 text-muted-foreground"
                  onClick={() => {
                    setFolder(null);
                    setView({ kind: "sources" });
                  }}
                  title="Back to sources"
                >
                  <XIcon />
                </Button>
              </div>
              <PathSpecifier
                distro={view.distro}
                onConfirm={(f) => {
                  setFolder(f);
                  setView({ kind: "sources" });
                }}
              />
            </div>
          ) : (
            <div>
              <p className="mb-1.5 text-sm font-medium text-muted-foreground">
                Add a folder on {localLabel}
              </p>
              <div className="space-y-1.5">
                {isTauri && (
                  <button
                    type="button"
                    onClick={() => void pickNativeFolder()}
                    className={`flex w-full items-center gap-2.5 rounded-md border border-border px-2.5 py-2 text-left hover:bg-accent ${
                      folder && !folder.startsWith("\\\\") ? "border-ring bg-accent/50" : ""
                    }`}
                  >
                    <Monitor className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">This computer</span>
                      <span className="block min-w-0 truncate text-xs text-muted-foreground" title={folder ?? undefined}>
                        {folder && !folder.startsWith("\\\\") ? folder : "Pick a folder with the system dialog"}
                      </span>
                    </span>
                  </button>
                )}
                {(distros ?? []).map((d) => {
                  const selected = !!folder?.startsWith(`\\\\wsl.localhost\\${d.name}\\`);
                  return (
                    <button
                      key={d.name}
                      type="button"
                      onClick={() => setView({ kind: "browse", distro: d.name })}
                      className={`flex w-full items-center gap-2.5 rounded-md border border-border px-2.5 py-2 text-left hover:bg-accent ${
                        selected ? "border-ring bg-accent/50" : ""
                      }`}
                    >
                      <span
                        className={`size-2 shrink-0 rounded-full ${d.running ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                        title={d.running ? "running" : "stopped"}
                      />
                      <HardDrive className="size-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">
                          WSL: {d.name}
                          {d.pretty_name ? ` (${d.pretty_name})` : ""}
                        </span>
                        <span className="block text-xs text-muted-foreground">Browse folders in the distro</span>
                      </span>
                    </button>
                  );
                })}
                {distros === null && isTauri && (
                  <div className="flex w-full items-center gap-2.5 rounded-md border border-border px-2.5 py-2 text-left text-muted-foreground">
                    <Spinner className="size-4 shrink-0" />
                    <span className="min-w-0 flex-1 text-sm">
                      Looking for WSL distros… (a cold WSL install can take a
                      while to answer the first time)
                    </span>
                  </div>
                )}
                {distros !== null && distros.length === 0 && isTauri && (
                  <p className="text-sm text-muted-foreground">No WSL distros found on {localLabel}.</p>
                )}
                {!isTauri && (
                  <p className="text-sm text-muted-foreground">
                    Folder picking needs the desktop app — choose an existing project or install Guild on your machine.
                  </p>
                )}
                {otherMachines.map((m) => (
                  <div
                    key={m.machine_id}
                    className="flex w-full items-center gap-2.5 rounded-md border border-border px-2.5 py-2 text-left opacity-50"
                    title="Browse coming later"
                  >
                    <HardDrive className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{m.name}</span>
                      <span className="block text-xs text-muted-foreground">browse coming later</span>
                    </span>
                  </div>
                ))}
              </div>
              {folder && (
                <p className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                  <FolderOpen className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate font-mono" title={folder}>
                    {folder}
                  </span>
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 hover:bg-foreground/10"
                    onClick={() => setFolder(null)}
                    title="Clear folder"
                  >
                    <XIcon className="size-3" />
                  </button>
                </p>
              )}
            </div>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" disabled={!name.trim() || !folder || busy} onClick={() => void create()}>
              {busy ? "Creating…" : "Create project"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
