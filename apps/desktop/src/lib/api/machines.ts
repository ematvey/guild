// Registered machines with their live socket state.

import { apiUrl, getToken } from "../session";

export interface MachineInfo {
  machine_id: string;
  name: string;
  os?: string;
  os_version?: string;
  app_version?: string;
  last_ip?: string;
  first_connected_at: string;
  last_connected_at: string;
  last_seen_at: string;
  /** The machine's singleton socket is live right now. */
  connected: boolean;
}

/** Connected machine executors for this account. */
export async function listMachines(): Promise<MachineInfo[] | null> {
  try {
    const res = await fetch(apiUrl("/api/v1/machines"), {
      headers: { authorization: `Bearer ${getToken()}` },
    });
    // null = request failed (distinguishable from a legitimately empty list)
    if (!res.ok) return null;
    const v = await res.json().catch(() => ({}));
    return v?.machines ?? [];
    } catch {
    // A rejected fetch (offline, TLS, server down) is a failure like any
    // other: the null contract covers it, so call sites only handle null.
    return null;
  }
}

