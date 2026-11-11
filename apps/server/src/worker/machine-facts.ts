// The worker-side `MachineFacts`: a forked worker holds no hub connection, so
// it asks the server which machines are live and where one's home folder is.
// The answer rides the fork IPC channel as a `reply` — the same lane and the
// same seam machine dispatch uses (worker/dispatch-proxy.ts): both go away
// when workers hold a hub connection.

import { MachineTargetError, type MachineFacts } from "../machines/targets.js";
import type { ServerReply, WorkerRequest } from "./protocol.js";

/** The server answers `fs_home` on the machine's own link; this bounds the
 *  wait, with the same grace the dispatch proxy allows. */
const HOME_TIMEOUT_MS = 20_000;

type FactsRequest = Extract<WorkerRequest, { t: "machine-online" | "machine-home" }>;

export class IpcMachineFacts implements MachineFacts {
  private pending = new Map<number, (outcome: { ok: true; data: unknown } | { ok: false; error: string }) => void>();

  constructor(
    private readonly send: (message: FactsRequest) => void,
    /** The worker's request ref counter, shared with its other requests. */
    private readonly nextRef: () => number,
  ) {}

  /** Feeds a server reply; returns true when it settled one of this proxy's
   *  requests. */
  onReply(message: ServerReply): boolean {
    const settle = this.pending.get(message.ref);
    if (settle === undefined) return false;
    this.pending.delete(message.ref);
    settle(message.ok ? { ok: true, data: message.data } : { ok: false, error: message.error });
    return true;
  }

  async online(orgId: string, machineIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (machineIds.length === 0) return new Set();
    const data = await this.ask({ t: "machine-online", ref: 0, orgId, machineIds: [...machineIds] }, 15_000);
    const ids = (data as { online?: unknown } | null)?.online;
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  }

  async home(orgId: string, machineId: string): Promise<string> {
    const data = await this.ask({ t: "machine-home", ref: 0, orgId, machineId }, HOME_TIMEOUT_MS);
    const home = (data as { home?: unknown } | null)?.home;
    if (typeof home !== "string" || home === "") throw new MachineTargetError("the machine reported no home folder");
    return home;
  }

  /** One request and its answer; a failed or unanswered request is a target
   *  error, so the model reads a sentence rather than a thrown process. */
  private async ask(message: FactsRequest, timeoutMs: number): Promise<unknown> {
    const ref = this.nextRef();
    const answered = new Promise<{ ok: true; data: unknown } | { ok: false; error: string }>((resolve) => {
      this.pending.set(ref, resolve);
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<{ ok: false; error: string }>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, error: "machine offline" }), timeoutMs);
      timer.unref?.();
    });
    try {
      this.send({ ...message, ref });
      const answer = await Promise.race([answered, timeout]);
      if (!answer.ok) throw new MachineTargetError(answer.error);
      return answer.data;
    } finally {
      this.pending.delete(ref);
      clearTimeout(timer);
    }
  }
}
