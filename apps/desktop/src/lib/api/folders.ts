// Folder sources: the app-process commands that browse local and remote
// directories, plus machine pairing tokens (spec §5).

import { invoke } from "@tauri-apps/api/core";

import { apiUrl, getToken } from "../session";

// ---- Folder sources (app-process commands; spec §5) ----

/** One WSL distro as a folder source. */
export interface Distro {
  name: string;
  running: boolean;
  pretty_name?: string | null;
}

/** One row of a directory listing. */
export interface DirEntry {
  name: string;
  is_dir: boolean;
}

export async function listWslDistros(): Promise<Distro[]> {
  return invoke<Distro[]>("list_wsl_distros");
}

/** The distro's default user home (LINUX path, e.g. /home/me); null when
 * unavailable. Cached per boot in the app process. */
export async function wslHome(distro: string): Promise<string | null> {
  return invoke<string | null>("wsl_home", { distro });
}

/** The distro's PRETTY_NAME (e.g. Arch Linux); null when unknown. Fetched
 * on first browse (user-driven), cached per boot in the app process. */
export async function wslPrettyName(distro: string): Promise<string | null> {
  return invoke<string | null>("wsl_pretty_name", { distro });
}

/** Unfiltered directory listing (dotfiles included), dirs first. */
export async function listDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("list_dir", { path });
}

/** A filesystem op on a REMOTE machine's executor socket, relayed by the
 * server (owner-scoped). `fs_list` → DirEntry[], `fs_home` → home path. */
export async function machineFsRequest(
  machineId: string,
  op: "fs_list" | "fs_home",
  payload: Record<string, unknown> = {},
): Promise<unknown> {
  const res = await fetch(apiUrl(`/api/v1/machines/${machineId}/fs`), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${getToken()}` },
    body: JSON.stringify({ op, payload }),
  });
  const v = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(v?.error?.message ?? `machine request failed (${res.status})`);
  return (v as { result: unknown }).result;
}

/** Directory listing on a remote machine (dirs first, dotfiles included). */
export async function listRemoteDir(machineId: string, path: string): Promise<DirEntry[]> {
  const v = (await machineFsRequest(machineId, "fs_list", { path })) as { entries: DirEntry[] };
  return v.entries;
}

/** The remote machine's $HOME (LINUX path); null when unknown. */
export async function remoteHome(machineId: string): Promise<string | null> {
  const v = (await machineFsRequest(machineId, "fs_home")) as { home?: string };
  return v.home || null;
}

/// Hands the app process the machine identity (stable per install; keys the
/// chat bindings). Starts presence + tool dispatch.
export async function setMachineIdentity(machineId: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("set_machine_identity", { machineId });
}

export interface PairingToken {
  id: string;
  secret: string;
  expires_at: string;
}

/// Issues a one-time pairing code for desktop enrollment. The full code is
/// composed client-side (`g1|<server_url>|<secret>`): the server URL is
/// routing info, the secret is the credential.
export async function createPairingToken(ttlMinutes = 30): Promise<PairingToken> {
  const token = getToken();
  const res = await fetch(apiUrl("/api/v1/auth/pairing-tokens"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ ttl_minutes: ttlMinutes }),
  });
  const v = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(v?.error?.message ?? res.statusText);
  return { id: v.id, secret: v.secret, expires_at: v.expires_at };
}

export function pairingCode(serverUrl: string, secret: string): string {
  return `g1|${serverUrl.replace(/\/$/, "")}|${secret}`;
}

