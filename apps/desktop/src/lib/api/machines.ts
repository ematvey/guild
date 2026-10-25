// Registered machines with their live socket state. The rows arrive in the
// member socket's `machine_list` frame; this module only declares the type.

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
