// Machine registry state shared by every view: the durable list comes from
// the HTTP snapshot, the live `connected` flag from `machine_status` frames
// on the member socket. One snapshot, so the sidebar project rows and the
// settings machine list repaint together.

import { useSyncExternalStore } from "react";
import { listMachines, type MachineInfo } from "./api/machines";

let snapshot: MachineInfo[] | null = null;
/** Bumped by clearMachines: a fetch that lands after sign-out is dropped. */
let epoch = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): MachineInfo[] | null {
  return snapshot;
}

/** The current list, or null until the first successful fetch. */
export function useMachines(): MachineInfo[] | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Applies one presence flip. Unknown machines and no-op flips are ignored;
 *  an empty store waits for the fetch, which carries the same truth. */
export function applyMachineStatus(machineId: string, online: boolean): void {
  if (snapshot === null) return;
  const current = snapshot.find((m) => m.machine_id === machineId);
  if (current === undefined || current.connected === online) return;
  snapshot = snapshot.map((m) => (m.machine_id === machineId ? { ...m, connected: online } : m));
  emit();
}

/** Reloads the registry over HTTP. Called at mount and on every socket
 *  reconnect, so a flip missed while disconnected is corrected. False when
 *  the fetch failed (the last good list stays on screen). */
export async function refreshMachines(): Promise<boolean> {
  const started = epoch;
  const list = await listMachines();
  if (list === null || started !== epoch) return false;
  snapshot = list;
  emit();
  return true;
}

/** Drops the list and invalidates the in-flight fetch; sign-out must call
 *  this so one user's machine inventory does not leak into the next session. */
export function clearMachinesCache(): void {
  epoch++;
  snapshot = null;
  emit();
}
