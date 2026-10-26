//! Machines section of the settings window: the durable registry of executor
//! machines (always rendered, chat or not). Machine tools (read_file,
//! execute, edit_file, write_file) execute on the machine a chat's project
//! is bound to, via the Guild desktop app running there — binding a chat
//! directly is not a thing; the project is the only binding surface. The
//! list holds every registered machine, connected or not; only the dot and
//! the last-seen stamp track live socket state. Deauthorizing forgets a
//! machine: its row goes, its session is revoked and its socket closes.

import { useState } from "react";
import { Cpu } from "lucide-react";
import { SkeletonForm } from "@guild/ui/components/skeleton";
import { Button } from "@guild/ui/components/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@guild/ui/components/dialog";
import { toast } from "sonner";
import { deauthorizeMachine, type MachineInfo } from "../../../lib/api/machines";
import { useMachines } from "../../../lib/machines-store";
import { relativeTime } from "../../../lib/relative-time";
import { PageHeader } from "../components/page-header";

export function MachineSection() {
  // The registry is shared app state: the member socket sends the rows and
  // patches the connected flag live, so an open page follows a machine
  // coming up or going down without a refetch.
  const machines = useMachines();
  const [target, setTarget] = useState<MachineInfo | null>(null);
  const [working, setWorking] = useState(false);

  const confirm = async () => {
    if (target === null || working) return;
    setWorking(true);
    try {
      await deauthorizeMachine(target.machine_id);
      // The machine_list frame that follows the delete repaints the list.
      toast.success("Machine deauthorized");
      setTarget(null);
    } catch (e) {
      toast.error("Deauthorize failed", { description: (e as Error).message });
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Machines" />
      {machines === null ? (
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
                <div className="flex shrink-0 items-center gap-2 pl-3">
                  <span className="text-xs text-muted-foreground">
                    {m.connected ? "connected" : ""}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    onClick={() => setTarget(m)}
                  >
                    Deauthorize
                  </Button>
                </div>
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

      <Dialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deauthorize {target?.name}?</DialogTitle>
            <DialogDescription>
              The machine is removed from this list and its app is signed out.
              Chats that ran there continue on the server. A machine with
              projects bound to it refuses — delete those projects first.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={working} onClick={() => void confirm()}>
              {working ? "Deauthorizing…" : "Deauthorize"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
