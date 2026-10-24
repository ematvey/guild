// The machine RPC bridge and this app instance's identities: the stable
// machine id (the executor key machine tools bind to) and the per-instance
// client id (the presence key for client-tool termination detection).

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

const CLIENT_ID_KEY = "guild_client_id";
const MACHINE_ID_KEY = "guild_machine_id";
/** Stable machine identity (per app install): the executor key machine
 * tools are bound to. */

export function machineId(): string {
  let id = localStorage.getItem(MACHINE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(MACHINE_ID_KEY, id);
  }
  return id;
}

/**
 * Poll-based rpc bridge: submit returns in <1ms; results are collected by a
 * single poll loop and routed to waiters by id. Long-lived invoke responses
 * (the old rpc_request shape) can be silently lost by Windows WebView2
 * deferral delivery — this never leaves an invoke open, so a slow or wedged
 * daemon surfaces as a caller-side timeout instead of an eternal spinner.
 * Resolves with the full JSON-RPC envelope (same shape rpc_request returned).
 */

const rpcWaiters = new Map<
  number,
  { resolve: (v: any) => void; reject: (e: Error) => void }
>();
// Results drained by the poll loop before their caller's waiter was
// registered (a fast call completes in the engine while its submit ack is
// still in flight). Kept briefly so the registration can pick them up.
const rpcOrphans = new Map<number, { value: any; at: number }>();
const RPC_ORPHAN_TTL_MS = 10000;
let rpcPolling = false;

/** Test hook: outstanding rpc waiters — the poll loop runs while this is > 0. */
export function rpcWaitersOutstanding(): number {
  return rpcWaiters.size;
}

async function rpcPollLoop(): Promise<void> {
  while (rpcWaiters.size > 0) {
    try {
      const batch: any[] = await invoke<any[]>("rpc_poll");
      for (const v of batch) {
        const w = rpcWaiters.get(v?.id);
        if (w) {
          rpcWaiters.delete(v.id);
          rpcOrphans.delete(v.id);
          if (v?.error) w.reject(new Error(v.error?.message ?? String(v.error)));
          else w.resolve(v);
        } else {
          rpcOrphans.set(v.id, { value: v, at: Date.now() });
        }
      }
      const now = Date.now();
      for (const [id, orphan] of rpcOrphans) {
        if (now - orphan.at > RPC_ORPHAN_TTL_MS) rpcOrphans.delete(id);
      }
    } catch {
      // engine restarting — keep polling until the caller's timeout fires
    }
    await new Promise((r) => setTimeout(r, 120));
  }
  rpcPolling = false;
}

export async function rpcCall(
  method: string,
  params: any,
  timeoutMs = 30000,
): Promise<any> {
  const id = await invoke<number>("rpc_submit", { method, params });
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      rpcWaiters.delete(id);
      reject(
        new Error(
          `${method} timed out after ${Math.round(timeoutMs / 1000)}s - the local Guild service did not answer. Quit every Guild process (incl. background ones) and reopen the app.`,
        ),
      );
    }, timeoutMs);
    rpcWaiters.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    const orphan = rpcOrphans.get(id);
    if (orphan) {
      rpcOrphans.delete(id);
      const w = rpcWaiters.get(id);
      // Same as the poll path: remove the waiter before settling, or the
      // entry lives forever and the poll loop never exits.
      rpcWaiters.delete(id);
      if (orphan.value?.error) {
        w?.reject(new Error(orphan.value.error?.message ?? String(orphan.value.error)));
      } else {
        w?.resolve(orphan.value);
      }
    }
    if (!rpcPolling) {
      rpcPolling = true;
      rpcPollLoop();
    }
  });
}

/** Human label of this machine (hostname via the engine). */
/** Stable per-app-instance identity — the presence key for client-tool
 * termination detection (server resolves suspended client tools when the
 * app holding this id disconnects). */

export function clientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

export type MachinePresence = { connected: boolean; displaced?: boolean; auth_required?: boolean };

export async function watchMachinePresence(update: (presence: MachinePresence) => void): Promise<() => void> {
  const unlisten = await listen<MachinePresence>("app-presence", (event) => update(event.payload));
  const presence = await invoke<MachinePresence>("machine_presence");
  if (presence) update(presence);
  return unlisten;
}

