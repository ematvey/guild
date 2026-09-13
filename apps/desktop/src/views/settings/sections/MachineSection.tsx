//! Machine section of the settings window: executor machines the user can
//! bind the current chat to, plus pairing guidance. Moved from the old
//! settings dialog (design: settings window, Machine section).

import { useEffect, useState } from "react";
import { Cpu } from "lucide-react";
import { Skeleton } from "@guild/ui/components/skeleton";
import { bindChat, listMachines, type MachineInfo } from "../../../transport";

// Last successful machine list; a remount renders it immediately and
// refreshes in the background instead of blinking the skeleton.
let lastMachines: MachineInfo[] | null = null;

export function MachineSection({
  currentMachineId,
  onMachineChanged,
  chatId,
}: {
  currentMachineId: string | null;
  onMachineChanged: () => void;
  chatId: string | null;
}) {
  const [machines, setMachines] = useState<MachineInfo[] | null>(lastMachines);
  useEffect(() => {
    void listMachines().then((m) => {
      lastMachines = m;
      setMachines(m);
    });
  }, []);

  return (
    <div className="space-y-3 pt-2">
      <p className="text-base text-muted-foreground">
        Machine tools (read, bash, edit, write) execute on the machine bound to
        the chat, via the Guild desktop app running there.
      </p>
      {!chatId ? (
        <p className="rounded-lg border border-border bg-card p-3 text-base text-muted-foreground">
          Open a chat to bind it to a machine.
        </p>
      ) : machines === null ? (
        <Skeleton className="h-16 w-full rounded-lg" />
      ) : machines.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-3 text-base text-muted-foreground">
          No machines connected. Start the Guild desktop app on the machine you
          want to use as the executor.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {machines.map((m) => (
            <button
              key={m.machine_id}
              onClick={async () => {
                await bindChat(chatId, m.machine_id);
                onMachineChanged();
              }}
              className={`flex items-center justify-between rounded-lg border px-3 py-2 text-left text-base outline-none transition-colors ${
                currentMachineId === m.machine_id
                  ? "border-foreground/40 bg-accent"
                  : "border-border bg-card hover:bg-accent/50"
              }`}
            >
              <span className="flex min-w-0 items-center gap-2">
                <Cpu className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{m.name}</span>
              </span>
              {currentMachineId === m.machine_id ? (
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">bound</span>
              ) : (
                <span className="text-xs text-muted-foreground">use</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
