// Registered machines with their live socket state. The rows arrive in the
// member socket's `machine_list` frame; this module declares the type and the
// one write the page makes (deauthorization).

import { request } from "./request";

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

/** Forgets a machine: drops its registry row, revokes the session it paired
 *  with and closes its socket. Chats that ran on it fall back to the server
 *  executor. A machine with bound projects refuses (409) — the message names
 *  them. */
export async function deauthorizeMachine(machineId: string): Promise<void> {
  await request<unknown>("DELETE", `/api/v1/machines/${encodeURIComponent(machineId)}`);
}
