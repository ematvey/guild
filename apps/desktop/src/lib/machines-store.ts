// Machine registry state shared by every view: the durable rows and the
// live `connected` flag both arrive as member-socket frames. One store, so
// the sidebar project rows and the settings machine list repaint together.

import { useSyncExternalStore } from "react";
import type { MachineInfo } from "./api/machines";

let snapshot: MachineInfo[] | null = null;
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

/** The current list, or null until the first workspace push. */
export function useMachines(): MachineInfo[] | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Replaces the registry rows (the `machine_list` frame). */
export function applyMachineList(machines: MachineInfo[]): void {
  snapshot = machines;
  emit();
}

/** Applies one presence flip. Unknown machines and no-op flips are ignored;
 *  an empty store waits for the list frame, which carries the same truth. */
export function applyMachineStatus(machineId: string, online: boolean): void {
  if (snapshot === null) return;
  const current = snapshot.find((m) => m.machine_id === machineId);
  if (current === undefined || current.connected === online) return;
  snapshot = snapshot.map((m) => (m.machine_id === machineId ? { ...m, connected: online } : m));
  emit();
}

/** Drops the list; sign-out must call this so one user's machine inventory
 *  does not leak into the next session. */
export function clearMachinesCache(): void {
  snapshot = null;
  emit();
}
