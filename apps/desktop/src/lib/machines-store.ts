// Machine registry state shared by every view: the durable rows and the
// live `connected` flag both arrive as member-socket frames. One store, so
// the sidebar project rows and the settings machine list repaint together.

import type { MachineInfo } from "./api/machines";
import { createStore } from "./store";

const machines = createStore<MachineInfo[] | null>(null);

/** The current list, or null until the first workspace push. */
export function useMachines(): MachineInfo[] | null {
  return machines.use();
}

/** Replaces the registry rows (the `machine_list` frame). */
export function applyMachineList(next: MachineInfo[]): void {
  machines.set(next);
}

/** Applies one presence flip. Unknown machines and no-op flips are ignored;
 *  an empty store waits for the list frame, which carries the same truth. */
export function applyMachineStatus(machineId: string, online: boolean): void {
  machines.update((list) => {
    const current = list?.find((m) => m.machine_id === machineId);
    if (list === null || current === undefined || current.connected === online) return list;
    return list.map((m) => (m.machine_id === machineId ? { ...m, connected: online } : m));
  });
}

/** Drops the list (sign-out resets it with every other store). */
export const clearMachinesCache = machines.reset;
