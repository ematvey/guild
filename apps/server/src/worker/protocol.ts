// The main server ↔ worker IPC protocol. One forked worker process owns
// one conversation's scoped harness (worker/main.ts); the supervisor routes
// admission, control, and ephemeral live frames over this channel. Durable
// transcript rows and approval decisions still cross through Postgres.
//
// Each direction has its own request space: a server request is answered by
// a `result` carrying the server's ref, a worker request by a `reply`
// carrying the worker's ref, so the two counters never meet.

import { ApiError } from "../platform/errors.js";
import { AdmissionCancelled } from "../harness/operations.js";
import type { StreamWireEvent } from "../hub/protocol.js";
import type { SubmitTurnInput } from "../harness/turn-backend.js";

export type BufferUpdate = { append: string } | { replace: string };

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

/** An answer: the value, or the error with its HTTP status and code when
 *  it was an ApiError. */
export type Outcome =
  | { ok: true; data: unknown }
  | { ok: false; error: string; status?: number; code?: string; cancelled?: true };

/** Server → worker: requests about the worker's own chat. */
export type ServerRequest =
  | { t: "submit"; ref: number; input: SubmitTurnInput }
  | { t: "deliver-steer"; ref: number; orgId: string; text: string; model: string | null }
  | { t: "deliver-message"; ref: number; orgId: string; text: string; model: string | null }
  | { t: "steer"; ref: number; submissionId: number }
  | { t: "withdraw"; ref: number; submissionId: number }
  | { t: "stop"; ref: number }
  | { t: "compact"; ref: number };

/** Server → worker: the answer to a worker request. */
export type ServerReply = { t: "reply"; ref: number } & Outcome;

export type ServerToWorker = ServerRequest | ServerReply;

/** Worker → server: requests the server serves for the worker. */
export type WorkerRequest =
  /** Machine-tool dispatch over the server's hub connection. */
  | { t: "dispatch"; ref: number; call: MachineDispatchCall }
  /** A worker admitting a turn for a chat it does not own (delegation):
   *  the server owns every other chat's worker, so it forwards this. */
  | { t: "remote-submit"; ref: number; chatId: string; input: SubmitTurnInput }
  /** A worker delivering a child result into a chat it does not own: the
   *  conversation handle is invocation-bound, so the owning worker does it. */
  | { t: "remote-deliver-steer"; ref: number; chatId: string; orgId: string; text: string; model: string | null }
  /** A worker posting an agent message into another chat (a routine feed). */
  | { t: "remote-deliver-message"; ref: number; chatId: string; orgId: string; text: string; model: string | null };

/** Worker → server: a fire-and-forget cancel of one of its dispatches. */
export type WorkerCancel = { t: "dispatch_cancel"; ref: number };

/** Worker → server: the answer to a server request. */
export type WorkerResult = { t: "result"; ref: number } & Outcome;

/** Worker → server: lifecycle and live-frame events. */
export type WorkerEvent =
  | { t: "ready" }
  | { t: "heartbeat" }
  | { t: "stream"; action: "open"; generationId: string }
  | { t: "stream"; action: "event"; event: StreamWireEvent }
  | { t: "stream"; action: "dirty" | "close" }
  | { t: "stream"; action: "buffers"; text?: BufferUpdate; thinking?: BufferUpdate }
  /** A turn ended in this worker: the server's push lane decides whether the
   *  owner needs a notification (the worker has no sockets of its own). */
  | { t: "turn-ended"; chatId: string; failed: boolean };

export type WorkerToServer = WorkerRequest | WorkerCancel | WorkerResult | WorkerEvent;

/** The failed outcome of `error`, keeping an ApiError's status and code
 *  (and a cancelled admission) so the caller's route answers what the
 *  other process answered. */
export function failure(error: unknown): Extract<Outcome, { ok: false }> {
  return {
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(error instanceof ApiError ? { status: error.status, code: error.code } : {}),
    ...(error instanceof AdmissionCancelled ? { cancelled: true as const } : {}),
  };
}

/** The error a failed outcome stands for: the ApiError or cancelled
 *  admission it carried, or a plain Error. */
export function failureError(outcome: Extract<Outcome, { ok: false }>): Error {
  if (outcome.cancelled === true) return new AdmissionCancelled();
  return outcome.status !== undefined && outcome.code !== undefined
    ? new ApiError(outcome.status, outcome.code, outcome.error)
    : new Error(outcome.error);
}
