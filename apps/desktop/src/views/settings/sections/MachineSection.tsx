//! Machines section of the settings window: the durable registry of executor
//! machines (always rendered, chat or not). Machine tools (read_file,
//! execute, edit_file, write_file) execute on the machine a chat's project
//! is bound to, via the Guild desktop app running there — binding a chat
//! directly is not a thing; the project is the only binding surface. The
//! list holds every registered machine, connected or not; only the dot and
//! the last-seen stamp track live socket state. Deauthorizing forgets a
//! machine: its row goes, its session is revoked and its socket closes.

import { useState } from "react";
import { Cpu, Plus } from "lucide-react";
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
import { PageHeader } from "../../../components/page-header";

export function MachineSection({ onSetupDevice }: { onSetupDevice?: () => void }) {
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
      <PageHeader
        inlineActions
        title="Devices"
        description="Connect computers that can run project tasks and access local files."
        actions={onSetupDevice && <Button variant="ghost" size="icon" className="size-8" aria-label="Set up a device" title="Set up a device" onClick={onSetupDevice}><Plus /></Button>}
      />
      {machines === null ? (
        <SkeletonForm />
      ) : machines.length === 0 ? (
        <p className="rounded-lg border border-border bg-card p-3 text-base text-muted-foreground">
          No devices connected. Set up a device to install Guild or pair an existing installation.
        </p>
      ) : (
        <div className="divide-y divide-border border-y border-border">
          {machines.map((m) => {
            const meta = [m.os, m.app_version, m.last_ip].filter(Boolean).join(" · ");
            return (
              <div
                key={m.machine_id}
                className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-base"
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  {m.connected ? (
                    <span className="inline-flex size-2 shrink-0 rounded-full bg-emerald-500" />
                  ) : (
                    <span className="size-2 shrink-0 rounded-full bg-muted-foreground/40" />
                  )}
                  <Cpu className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="min-w-0 break-words">{m.name}</span>
                      {!m.connected && (
                        <span className="shrink-0 text-base text-muted-foreground">
                          last seen {relativeTime(m.last_seen_at)}
                        </span>
                      )}
                    </span>
                    {!m.connected && meta && (
                      <span className="mt-0.5 block break-words text-base text-muted-foreground">{meta}</span>
                    )}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2 pl-3">
                  <span className="text-base text-muted-foreground">{m.connected ? "connected" : ""}</span>
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setTarget(m)}>
                    Deauthorize
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Dialog open={target !== null} onOpenChange={(open) => !open && setTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deauthorize {target?.name}?</DialogTitle>
            <DialogDescription>
              The machine is removed from this list and its app is signed out. Chats that ran there continue on the
              server. A machine with projects bound to it refuses — delete those projects first.
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
