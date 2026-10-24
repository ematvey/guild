// Create-project dialog (spec §5): name + "Add a folder on <machine>".
// Folder sources for the local machine: a native folder dialog, or a WSL
// distro browsed in-app (the path specifier). Folders on other machines are
// browsed in-app too: the listing relays through the server to the
// machine's executor socket (read-only ops).

import { useEffect, useState } from "react";
import { HardDrive, Monitor, X as XIcon } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@guild/ui/components/dialog";
import { Button } from "@guild/ui/components/button";
import { Spinner } from "@guild/ui/components/spinner";
import { toast } from "sonner";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { createProject, type Project } from "../../lib/api/projects";
import { listWslDistros, wslPrettyName, type Distro } from "../../lib/api/folders";
import type { MachineInfo } from "../../lib/api/machines";
import { PathSpecifier } from "./PathSpecifier";
import { RemotePathSpecifier } from "./RemotePathSpecifier";

type View =
  | { kind: "sources" }
  | { kind: "browse"; distro: string }
  | { kind: "machine"; machine: MachineInfo };

export function CreateProjectDialog({
  open,
  onOpenChange,
  machines,
  localMachineId,
  isTauri,
  projects,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  machines: MachineInfo[] | null;
  localMachineId: string;
  isTauri: boolean;
  /** The caller's project list — a picked folder that is already a project
   * opens it instead of creating a duplicate. */
  projects: Project[] | null;
  /** Called with the opened-or-created project (the caller selects it). */
  onCreated: (project: Project) => void;
}) {
  const [view, setView] = useState<View>({ kind: "sources" });
  const [distros, setDistros] = useState<Distro[] | null>(null);
  const [, setBusy] = useState(false);

  const localMachine = machines?.find((m) => m.machine_id === localMachineId);
  const localLabel = localMachine?.name ?? "this computer";
  const otherMachines = machines?.filter((m) => m.machine_id !== localMachineId) ?? [];

  // Entering a distro's browse view boots that distro (the listing needs
  // it) — the moment the pretty-name lookup can also run without starting
  // anything the user did not choose.
  useEffect(() => {
    if (view.kind !== "browse") return;
    const distro = view.distro;
    void wslPrettyName(distro)
      .then((pretty) => {
        if (!pretty) return;
        setDistros((cur) =>
          cur?.map((d) => (d.name === distro && !d.pretty_name ? { ...d, pretty_name: pretty } : d)) ?? cur,
        );
      })
      .catch(() => {});
  }, [view]);

  useEffect(() => {
    if (!open) {
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

  /** The project already bound to this machine + folder, if any. Folder
   * comparison is case-insensitive: Windows paths differ in case freely. */
  const existingFor = (folder: string): Project | null =>
    (projects ?? []).find(
      (p) =>
        p.machine_id === localMachineId &&
        p.folder.replace(/\\+$/, "").toLowerCase() === folder.replace(/\\+$/, "").toLowerCase(),
    ) ?? null;

  /** Remote variant: the binding carries the machine's id, and Linux paths
   * compare case-sensitively. */
  const existingForMachine = (machineId: string) => (folder: string): Project | null =>
    (projects ?? []).find((p) => p.machine_id === machineId && p.folder === folder) ?? null;

  /** Choosing a folder commits immediately: an existing project opens, a
   * new one is created with the folder's basename as its name. */
  const commitFolder = async (folder: string, machineId: string = localMachineId) => {
    const existing =
      machineId === localMachineId ? existingFor(folder) : existingForMachine(machineId)(folder);
    if (existing) {
      onCreated(existing);
      onOpenChange(false);
      return;
    }
    setBusy(true);
    try {
      const project = await createProject({ folder, machine_id: machineId });
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
    if (typeof picked === "string") void commitFolder(picked);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="!flex max-h-[calc(100dvh-3rem)] max-w-[calc(100vw-2rem)] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add project</DialogTitle>
          <DialogDescription>
            Pick a folder — a project is created for it, or an existing one opens.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
          {view.kind === "machine" ? (
            <div className="flex min-h-40 min-w-0 flex-1 flex-col gap-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">
                  Folder on <span className="font-mono">{view.machine.name}</span>
                </p>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 text-muted-foreground"
                  onClick={() => setView({ kind: "sources" })}
                  title="Back to sources"
                >
                  <XIcon />
                </Button>
              </div>
              <RemotePathSpecifier
                machineId={view.machine.machine_id}
                existingFor={existingForMachine(view.machine.machine_id)}
                onConfirm={(f) => void commitFolder(f, view.kind === "machine" ? view.machine.machine_id : localMachineId)}
              />
            </div>
          ) : view.kind === "browse" ? (
            <div className="flex min-h-40 min-w-0 flex-1 flex-col gap-2">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">
                  Folder in <span className="font-mono">{view.distro}</span>
                </p>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 text-muted-foreground"
                  onClick={() => setView({ kind: "sources" })}
                  title="Back to sources"
                >
                  <XIcon />
                </Button>
              </div>
              <PathSpecifier
                distro={view.distro}
                existingFor={existingFor}
                onConfirm={(f) => void commitFolder(f)}
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
                    className="flex w-full items-center gap-2.5 rounded-md border border-border px-2.5 py-2 text-left hover:bg-accent"
                  >
                    <Monitor className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">This computer</span>
                      <span className="block min-w-0 truncate text-xs text-muted-foreground">
                        Pick a folder with the system dialog
                      </span>
                    </span>
                  </button>
                )}
                {(distros ?? []).map((d) => {
                  return (
                    <button
                      key={d.name}
                      type="button"
                      onClick={() => setView({ kind: "browse", distro: d.name })}
                      className="flex w-full items-center gap-2.5 rounded-md border border-border px-2.5 py-2 text-left hover:bg-accent"
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
                  <button
                    key={m.machine_id}
                    type="button"
                    disabled={!m.connected}
                    onClick={() => setView({ kind: "machine", machine: m })}
                    className={`flex w-full items-center gap-2.5 rounded-md border border-border px-2.5 py-2 text-left hover:bg-accent ${
                      m.connected ? "" : "opacity-50"
                    }`}
                    title={m.connected ? "Browse folders on this machine" : "Machine is offline"}
                  >
                    <span
                      className={`size-2 shrink-0 rounded-full ${m.connected ? "bg-emerald-500" : "bg-muted-foreground/40"}`}
                      title={m.connected ? "online" : "offline"}
                    />
                    <HardDrive className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{m.name}</span>
                      <span className="block text-xs text-muted-foreground">
                        {m.connected ? "Browse folders on this machine" : "Offline — start Guild on it"}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}

        </div>
      </DialogContent>
    </Dialog>
  );
}
