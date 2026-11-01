// The main server ↔ worker IPC protocol. One forked worker process owns
// one conversation's scoped harness (worker/main.ts); the supervisor routes
// admission, control, and ephemeral live frames over this channel. Durable
// transcript rows and approval decisions still cross through Postgres.

import type { StreamWireEvent } from "../hub/protocol.js";

export type BufferUpdate = { append: string } | { replace: string };
export type WorkerStreamEvent =
  | { t: "stream"; action: "open"; generationId: string }
  | { t: "stream"; action: "event"; event: StreamWireEvent }
  | { t: "stream"; action: "dirty" | "close" }
  | { t: "stream"; action: "buffers"; text?: BufferUpdate; thinking?: BufferUpdate }
  /** A turn ended in this worker: the server's push lane decides whether the
   *  owner needs a notification (the worker has no sockets of its own). */
  | { t: "turn-ended"; chatId: string; failed: boolean };

/** One machine-tool dispatch, proxied from a worker to the server's
 *  hub-backed registry (the same shape MachineDispatch.dispatch takes). */
export interface MachineDispatchCall {
  machineId: string;
  orgId: string;
  chatId: string;
  name: string;
  args: Record<string, unknown>;
  workdir: string | null;
  timeoutMs: number;
}

/** What the server routes into a worker. `SubmitTurnInput` is the same
 *  shape the HTTP routes assemble; the worker runs the full admission
 *  path (conversation bootstrap, configure, integrations, submit).
 *  `dispatch` flows the other way (worker → server): the worker's env
 *  proxies machine-tool dispatch to the server's hub connection. */
export interface SubmitTurnWireInput {
  orgId: string;
  requestId: string;
  content: string;
  images: { mimeType: string; data: string }[];
  model: string | null;
  sendMode?: "steer" | "queue";
  skillsIndex?: string;
  /** The desktop's project instruction chain; the worker applies it to the
   *  conversation's project instructions at admission. */
  agentsMd?: string;
}

export type WorkerRequest =
  | {
      t: "submit";
      ref: number;
      input: SubmitTurnWireInput;
    }
  | {
      t: "deliver-steer";
      ref: number;
      orgId: string;
      text: string;
      model: string | null;
    }
  | { t: "steer"; ref: number; submissionId: number }
  | { t: "withdraw"; ref: number; submissionId: number }
  | { t: "stop"; ref: number }
  | { t: "compact"; ref: number }
  | { t: "dispatch"; ref: number; call: MachineDispatchCall }
  | { t: "dispatch_cancel"; ref: number };

export type WorkerResponse =
  | { t: "result"; ref: number; ok: true; data: unknown }
  | { t: "result"; ref: number; ok: false; error: string; status?: number; code?: string }
  /** A worker admitting a turn for a chat it does not own (delegation):
   *  the server owns every other chat's worker, so it forwards this. */
  | { t: "remote-submit"; ref: number; chatId: string; input: SubmitTurnWireInput }
  /** A worker delivering a child result into a chat it does not own: the
   *  conversation handle is invocation-bound, so the owning worker does it. */
  | {
      t: "remote-deliver-steer";
      ref: number;
      chatId: string;
      orgId: string;
      text: string;
      model: string | null;
    };

export type WorkerEvent = { t: "ready" } | { t: "heartbeat" } | WorkerStreamEvent;

export type WorkerMessage = WorkerRequest | WorkerResponse | WorkerEvent;
