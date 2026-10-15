// The worker-side machine-dispatch proxy: the forked worker has no hub
// connection, so its ExecutionEnv proxies machine-tool dispatch to the
// server over the fork IPC channel ({t:"dispatch"} → the supervisor calls
// the hub-backed MachineDispatch → the outcome rides back as a
// WorkerResponse). Timeout semantics match the direct path: the caller's
// timeoutMs bounds the wait, with a grace window so the server's
// authoritative outcome (offline / settled / timed-out) wins when it is
// merely slow; past that the proxy answers with the offline shape.

import type { MachineToolOutcome } from "../machines/dispatch.js";
import type { MachineDispatchCall, WorkerResponse } from "./protocol.js";

/** The server's answer arrives after its own dispatch resolves (bounded by
 *  the same timeoutMs); this grace covers IPC + scheduler latency only. */
const REPLY_GRACE_MS = 30_000;

const OFFLINE: MachineToolOutcome = {
  content: "machine offline",
  is_error: true,
  meta: null,
  images: [],
};

export class IpcMachineDispatch {
  private pending = new Map<number, (outcome: MachineToolOutcome) => void>();
  private seq = 0;

  constructor(
    private readonly send: (message: { t: "dispatch"; ref: number; call: MachineDispatchCall }) => void,
  ) {}

  /** Feeds a WorkerResponse that carries a dispatch reply; returns true
   *  when it settled one of this proxy's calls. */
  onResponse(message: WorkerResponse): boolean {
    if (message.t !== "result") return false;
    const settle = this.pending.get(message.ref);
    if (!settle) return false;
    this.pending.delete(message.ref);
    if (message.ok) settle(message.data as MachineToolOutcome);
    else settle({ content: `machine dispatch failed: ${message.error}`, is_error: true, meta: null, images: [] });
    return true;
  }

  async dispatch(call: MachineDispatchCall): Promise<MachineToolOutcome> {
    const ref = (this.seq += 1);
    const done = new Promise<MachineToolOutcome>((resolve) => {
      this.pending.set(ref, resolve);
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<MachineToolOutcome>((resolve) => {
      timer = setTimeout(() => resolve(OFFLINE), call.timeoutMs + REPLY_GRACE_MS);
      timer.unref?.();
    });
    try {
      this.send({ t: "dispatch", ref, call });
      return await Promise.race([done, timeout]);
    } finally {
      this.pending.delete(ref);
      clearTimeout(timer);
    }
  }
}
