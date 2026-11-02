// The machine RPC bridge and this app instance's identities: the stable
// machine id (the executor key machine tools bind to) and the per-instance
// client id (the presence key for client-tool termination detection).

import type { WebviewRpcMethod, WebviewRpcResults } from "@guild/wire/rpc";
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
 * Push-based rpc bridge: `rpc_submit` returns the request id in <1ms, and
 * the app process emits each finished reply as an `engine-rpc` event to the
 * main window. One listener routes replies to waiters by id. No invoke is
 * ever left open (Windows WebView2 can silently lose long-lived invoke
 * responses), so a slow or wedged engine surfaces as a caller-side timeout
 * instead of an eternal spinner. Resolves with the full JSON-RPC envelope.
 */

/** The Tauri event carrying each finished engine reply (`RPC_EVENT` in
 *  src-tauri/src/lib.rs). */
export const RPC_EVENT = "engine-rpc";

/** One JSON-RPC reply from the engine. `R` is the method's result shape. */
export interface RpcEnvelope<R = unknown> {
  id: number;
  result?: R;
  error?: { message?: string; code?: number } | null;
}

const rpcWaiters = new Map<number, { resolve: (v: RpcEnvelope) => void; reject: (e: Error) => void }>();
// Replies pushed before their caller's waiter was registered (a fast call
// completes in the engine while its submit ack is still in flight). Kept
// briefly so the registration can pick them up.
const rpcOrphans = new Map<number, { value: RpcEnvelope; at: number }>();
const RPC_ORPHAN_TTL_MS = 10000;
let subscription: Promise<unknown> | null = null;

/** Test hook: outstanding rpc waiters. */
export function rpcWaitersOutstanding(): number {
  return rpcWaiters.size;
}

function settle(v: RpcEnvelope, w: { resolve: (v: RpcEnvelope) => void; reject: (e: Error) => void }) {
  if (v.error) w.reject(rpcError(v.error));
  else w.resolve(v);
}

function onReply(v: RpcEnvelope): void {
  if (typeof v?.id !== "number") return;
  const now = Date.now();
  for (const [id, orphan] of rpcOrphans) {
    if (now - orphan.at > RPC_ORPHAN_TTL_MS) rpcOrphans.delete(id);
  }
  const w = rpcWaiters.get(v.id);
  if (w) {
    rpcWaiters.delete(v.id);
    settle(v, w);
  } else {
    rpcOrphans.set(v.id, { value: v, at: now });
  }
}

/** Subscribes to the reply event once per app run; a failed subscribe is
 *  retried by the next call. */
function subscribe(): Promise<unknown> {
  subscription ??= listen<RpcEnvelope>(RPC_EVENT, (event) => onReply(event.payload)).catch((e) => {
    subscription = null;
    throw e;
  });
  return subscription;
}

function rpcError(error: NonNullable<RpcEnvelope["error"]>): Error {
  return new Error(error.message ?? String(error));
}

/** Calls one engine method; the reply's `result` is typed by the method
 *  (`WebviewRpcResults` in @guild/wire/rpc). An error reply rejects. */
export async function rpcCall<M extends WebviewRpcMethod>(
  method: M,
  params: Record<string, unknown>,
  timeoutMs = 30000,
): Promise<RpcEnvelope<WebviewRpcResults[M]>> {
  await subscribe();
  const id = await invoke<number>("rpc_submit", { method, params });
  return new Promise<RpcEnvelope<WebviewRpcResults[M]>>((resolve, reject) => {
    const timer = setTimeout(() => {
      rpcWaiters.delete(id);
      reject(
        new Error(
          `${method} timed out after ${Math.round(timeoutMs / 1000)}s - the local Guild service did not answer. Quit every Guild process (incl. background ones) and reopen the app.`,
        ),
      );
    }, timeoutMs);
    const waiter = {
      resolve: (v: RpcEnvelope) => {
        clearTimeout(timer);
        resolve(v as RpcEnvelope<WebviewRpcResults[M]>);
      },
      reject: (e: Error) => {
        clearTimeout(timer);
        reject(e);
      },
    };
    const orphan = rpcOrphans.get(id);
    if (orphan) {
      rpcOrphans.delete(id);
      settle(orphan.value, waiter);
      return;
    }
    rpcWaiters.set(id, waiter);
  });
}

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
