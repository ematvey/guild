// The machine RPC bridge and this app instance's identities: the stable
// machine id (the executor key machine tools bind to) and the per-instance
// client id (the presence key for client-tool termination detection).

import { invoke } from "@tauri-apps/api/core";

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
 * can be silently lost by Windows WebView2
 * deferral delivery — this never leaves an invoke open, so a slow or wedged
 * daemon surfaces as a caller-side timeout instead of an eternal spinner.
 * Resolves with the full JSON-RPC envelope.
 */

/** One JSON-RPC reply from the engine. `R` is the method's result shape,
 *  named by the caller; the bridge itself never reads it. */
export interface RpcEnvelope<R = unknown> {
  id: number;
  result?: R;
  error?: { message?: string; code?: number } | null;
}

const rpcWaiters = new Map<
  number,
  { resolve: (v: RpcEnvelope) => void; reject: (e: Error) => void }
>();
// Results drained by the poll loop before their caller's waiter was
// registered (a fast call completes in the engine while its submit ack is
// still in flight). Kept briefly so the registration can pick them up.
const rpcOrphans = new Map<number, { value: RpcEnvelope; at: number }>();
const RPC_ORPHAN_TTL_MS = 10000;
let rpcPolling = false;

/** Test hook: outstanding rpc waiters — the poll loop runs while this is > 0. */
export function rpcWaitersOutstanding(): number {
  return rpcWaiters.size;
}

async function rpcPollLoop(): Promise<void> {
  while (rpcWaiters.size > 0) {
    try {
      const batch = await invoke<RpcEnvelope[]>("rpc_poll");
      for (const v of batch) {
        const w = rpcWaiters.get(v?.id);
        if (w) {
          rpcWaiters.delete(v.id);
          rpcOrphans.delete(v.id);
          if (v?.error) w.reject(rpcError(v.error));
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

function rpcError(error: NonNullable<RpcEnvelope["error"]>): Error {
  return new Error(error.message ?? String(error));
}

/** Calls one engine method. The result type is the caller's claim about the
 *  method's reply; it defaults to an unchecked shape for the call sites that
 *  read fields ad hoc. */
export async function rpcCall<R = any>(
  method: string,
  params: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<RpcEnvelope<R>> {
  const id = await invoke<number>("rpc_submit", { method, params });
  return new Promise<RpcEnvelope<R>>((resolve, reject) => {
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
        resolve(v as RpcEnvelope<R>);
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
        w?.reject(rpcError(orphan.value.error));
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

