//! Machine section of the settings window: the live inventory of executor
//! machines (always rendered, chat or not), plus binding controls when a
//! chat is open — machine tools (read_file, execute, edit_file, write_file)
//! execute on the machine bound to the chat, via the Guild desktop app
//! running there. Without an open chat the section is read-only inventory:
//! binding is a per-chat decision, made from the composer chip or here once
//! a chat is open.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Cpu } from "lucide-react";
import { Skeleton } from "@guild/ui/components/skeleton";
import { bindChat, listMachines, type MachineInfo } from "../../../transport";
import { PageHeader } from "../components/page-header";

// Last successful machine list; a remount renders it immediately and
// refreshes in the background instead of blinking the skeleton.
let lastMachines: MachineInfo[] | null = null;

/** Drops the cached machine list; sign-out must call this so one user's
 * machine inventory does not leak into the next session. */
export function clearMachinesCache(): void {
  lastMachines = null;
}

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
      if (m === null) {
        toast.error("Could not load machines");
        return; // keep the last good list on screen
      }
      lastMachines = m;
      setMachines(m);
    });
  }, []);

  const bind = async (machineId: string | null) => {
    if (!chatId) return;
    const res = await bindChat(chatId, machineId);
    if (res === null) {
      toast.error("Binding failed");
      return;
    }
    onMachineChanged();
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Machine" />
      {machines === null ? (
        <Skeleton className="h-16 w-full rounded-lg" />
      ) : machines.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-3 text-base text-muted-foreground">
          No machines bound yet. Start the Guild desktop app on the machine and
          sign it in with a device token (Settings → Connect desktop app in the
          web app generates one); the machine appears here once it signs in.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {machines.map((m) => {
            const bound = currentMachineId === m.machine_id;
            return (
              <div
                key={m.machine_id}
                className={`flex items-center justify-between rounded-lg border px-3 py-2 text-base transition-colors ${
                  bound ? "border-foreground/40 bg-accent" : "border-border bg-card"
                } ${chatId ? "hover:bg-accent/50" : ""}`}
              >
                <button
                  onClick={() => void bind(m.machine_id)}
                  disabled={!chatId || bound}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none disabled:cursor-default"
                  title={chatId ? `Bind this chat to ${m.name}` : `Connected executor: ${m.name}`}
                >
                  {/* The endpoint only returns machines with fresh
                      heartbeats, so presence in the list = connected. */}
                  <span className="relative flex size-2 shrink-0">
                    <span className="absolute inline-flex size-2 animate-ping rounded-full bg-emerald-500/60" />
                    <span className="relative inline-flex size-2 rounded-full bg-emerald-500" />
                  </span>
                  <Cpu className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{m.name}</span>
                </button>
                {bound ? (
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      bound
                    </span>
                    {chatId && (
                      <button
                        onClick={() => void bind(null)}
                        className="text-xs text-muted-foreground outline-none hover:text-foreground"
                        title="Unbind this chat"
                      >
                        unbind
                      </button>
                    )}
                  </div>
                ) : (
                  <span className="shrink-0 pl-3 text-xs text-muted-foreground">
                    {chatId ? "use" : "connected"}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!chatId && (
        <p className="rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
          Machines bind at device sign-in: sign in with a device token on the
          machine and it shows up here, ready for your chats. Open a chat to
          switch which connected machine that chat uses.
        </p>
      )}
    </div>
  );
}
