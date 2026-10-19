//! Machine section of the settings window: the durable registry of executor
//! machines (always rendered, chat or not). Machine tools (read_file,
//! execute, edit_file, write_file) execute on the machine a chat's project
//! is bound to, via the Guild desktop app running there — binding a chat
//! directly is not a thing; the project is the only binding surface. The
//! list holds every registered machine, connected or not; only the dot and
//! the last-seen stamp track live socket state.

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Cpu } from "lucide-react";
import { SkeletonForm } from "@guild/ui/components/skeleton";
import { listMachines, type MachineInfo } from "../../../transport";
import { relativeTime } from "../../../lib/relative-time";
import { cacheEpochChanged, currentCacheEpoch } from "../use-cached-api";
import { PageHeader } from "../components/page-header";

// Last successful machine list; a remount renders it immediately and
// refreshes in the background instead of blinking the skeleton.
let lastMachines: MachineInfo[] | null = null;
// Generation of the in-flight machine refresh; clearMachinesCache bumps it
// so a response landing after sign-out is dropped instead of repopulating.
let machinesEpoch = 0;

/** Drops the cached machine list and invalidates the in-flight refresh;
 * sign-out must call this so one user's machine inventory does not leak
 * into the next session. */
export function clearMachinesCache(): void {
  machinesEpoch++;
  lastMachines = null;
}

export function MachineSection() {
  const [loadError, setLoadError] = useState(false);
  const [machines, setMachines] = useState<MachineInfo[] | null>(lastMachines);
  useEffect(() => {
    const epoch = currentCacheEpoch();
    void listMachines().then((m) => {
      if (cacheEpochChanged(epoch)) return;
      if (m === null) {
        setLoadError(true);
        toast.error("Could not load machines");
        return; // keep the last good list on screen
      }
      lastMachines = m;
      setMachines(m);
    });
  }, []);

  return (
    <div className="space-y-4">
      <PageHeader title="Machine" />
      {machines === null && loadError ? <p role="alert" className="text-sm text-destructive">Could not load machines.</p> : machines === null ? (
        <SkeletonForm />
      ) : machines.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-3 text-base text-muted-foreground">
          No machines yet. Start the Guild desktop app on the machine and sign
          it in with a device token (Settings → Connect desktop app in the web
          app generates one); the machine appears here once it signs in.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {machines.map((m) => {
            const meta = [m.os, m.app_version, m.last_ip].filter(Boolean).join(" · ");
            return (
              <div
                key={m.machine_id}
                className="flex items-center justify-between rounded-lg border border-border bg-card px-3 py-2 text-base"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  {m.connected ? (
                    <span className="inline-flex size-2 shrink-0 rounded-full bg-emerald-500" />
                  ) : (
                    <span className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
                  )}
                  <Cpu className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate">{m.name}</span>
                      {!m.connected && (
                        <span className="shrink-0 text-xs text-muted-foreground">
                          last seen {relativeTime(m.last_seen_at)}
                        </span>
                      )}
                    </span>
                    {!m.connected && meta && (
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        {meta}
                      </span>
                    )}
                  </span>
                </div>
                <span className="shrink-0 pl-3 text-xs text-muted-foreground">
                  {m.connected ? "connected" : ""}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <p className="rounded-lg border border-border bg-card p-3 text-sm text-muted-foreground">
        Machines bind at device sign-in: sign in with a device token on the
        machine and it shows up here, ready for your chats. A chat runs on the
        machine its project names — bind the project, not the chat.
      </p>
    </div>
  );
}
