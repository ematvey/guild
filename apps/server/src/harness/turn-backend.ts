// Where a chat's turns run. The runtime takes one placement and routes every
// turn operation through the backend it yields, so its own methods carry no
// mode branches:
//   in-process — this process holds the harness and runs every chat;
//   workers    — the server forks one worker per active chat
//                (worker/supervisor.ts) and holds no harness;
//   worker     — this process is a forked worker scoped to one chat; turns
//                for any other chat go back to the server.

import type { ForkSupervisor } from "../worker/supervisor.js";
import type { GenerationStreamSink, LiveBuffers } from "../chats/bridge.js";
import type { MachineDispatch } from "../machines/dispatch.js";

/** A turn submitted into a chat's conversation. The HTTP routes assemble
 *  it; worker IPC carries it unchanged. */
export interface SubmitTurnInput {
  orgId: string;
  /** The command id (turn_commands row): the submission's request id, so a
   *  retried dispatch cannot double-admit. */
  requestId: string;
  /** Composed user turn content (typed message + inlined attachment text). */
  content: string;
  /** Model-facing image parts (data URIs), when the route supports them. */
  images: { mimeType: string; data: string }[];
  model: string | null;
  /** Requested placement when the conversation is busy: "steer" places the
   *  input after the current tool round and joins the running turn;
   *  absent (and "queue") is the default follow-up — the input waits for
   *  the turn's final boundary and starts the next run. */
  sendMode?: "queue" | "steer";
  /** The machine turn's client-assembled skills index (the combined
   *  section's local portion); browser/server turns send none. */
  skillsIndex?: string;
  /** The desktop's project instruction chain (global config-dir file plus
   *  the project's AGENTS.md chain); browser/server turns send none. */
  agentsMd?: string;
}

/** Turns for chats this process does not own, sent to the process that
 *  does (a worker's delegation to another chat). */
export interface RemoteTurns {
  submit(chatId: string, orgId: string, input: SubmitTurnInput): Promise<number>;
  deliverSteer(chatId: string, orgId: string, text: string, model: string | null): Promise<void>;
}

export type TurnPlacement =
  | { kind: "in-process" }
  | { kind: "workers"; supervisor: ForkSupervisor }
  | {
      kind: "worker";
      chatId: string;
      /** The IPC machine-dispatch proxy: a worker has no hub, so
       *  machine-bound chats proxy dispatch to the server's registry. */
      dispatch: Pick<MachineDispatch, "dispatch">;
      remote: RemoteTurns;
    };

/** The turn operations this process runs against its own harness. */
export interface LocalTurns {
  submit(chatId: string, orgId: string, input: SubmitTurnInput, signal: AbortSignal): Promise<number>;
  deliverSteer(chatId: string, orgId: string, text: string, model: string | null): Promise<void>;
  steer(chatId: string, submissionId: number): Promise<boolean>;
  withdraw(chatId: string, submissionId: number): Promise<string>;
  stop(chatId: string): Promise<void>;
  compact(chatId: string): Promise<number | null>;
  liveBuffers(chatId: string): LiveBuffers;
}

export interface TurnBackend extends LocalTurns {
  /** Whether this process runs the chat's turns (a worker runs only its
   *  own chat; the server runs every chat, here or in a worker). */
  owns(chatId: string): boolean;
  /** The one chat a worker is scoped to; undefined elsewhere. */
  readonly scope: string | undefined;
  /** Whether this process opens a harness at all. */
  readonly hostsHarness: boolean;
  /** Whether this process owns the whole database (stale-run sweeps,
   *  boot-time mapping of every chat with work). */
  readonly ownsDatabase: boolean;
  /** The dispatch a worker's machine-bound chat uses; undefined: the
   *  process's own hub. */
  readonly machineDispatch: Pick<MachineDispatch, "dispatch"> | undefined;
  /** Boot recovery for chats with pending work, when workers run them. */
  recover(chats: { chatId: string }[]): Promise<void>;
  setStreamSink(sink: GenerationStreamSink | null): void;
  setTurnEnded(hook: ((chatId: string, failed: boolean) => Promise<void>) | null): void;
  close(): Promise<void>;
}

export function turnBackend(placement: TurnPlacement, local: LocalTurns): TurnBackend {
  switch (placement.kind) {
    case "in-process":
      return {
        ...local,
        owns: () => true,
        scope: undefined,
        hostsHarness: true,
        ownsDatabase: true,
        machineDispatch: undefined,
        recover: async () => {},
        setStreamSink: () => {},
        setTurnEnded: () => {},
        close: async () => {},
      };
    case "workers": {
      const forker = placement.supervisor;
      return {
        submit: (chatId, _orgId, input) => forker.submit(chatId, input),
        deliverSteer: (chatId, orgId, text, model) => forker.deliverSteer(chatId, orgId, text, model),
        steer: (chatId, submissionId) => forker.steer(chatId, submissionId),
        withdraw: (chatId, submissionId) => forker.withdraw(chatId, submissionId),
        stop: (chatId) => forker.stop(chatId),
        compact: (chatId) => forker.compact(chatId),
        liveBuffers: (chatId) => forker.liveBuffers(chatId),
        owns: () => true,
        scope: undefined,
        hostsHarness: false,
        ownsDatabase: true,
        machineDispatch: undefined,
        recover: (chats) => forker.recoverFromJournal(chats),
        setStreamSink: (sink) => forker.setStreamSink(sink),
        setTurnEnded: (hook) => forker.setTurnEnded(hook),
        close: () => forker.close(),
      };
    }
    case "worker": {
      const own = placement.chatId;
      const owns = (chatId: string): boolean => chatId === own;
      return {
        ...local,
        // The conversation handle is invocation-bound: only the worker that
        // owns a chat can open it, so another chat's turn goes back to the
        // server, which owns every chat's worker.
        submit: (chatId, orgId, input, signal) =>
          owns(chatId) ? local.submit(chatId, orgId, input, signal) : placement.remote.submit(chatId, orgId, input),
        deliverSteer: (chatId, orgId, text, model) =>
          owns(chatId)
            ? local.deliverSteer(chatId, orgId, text, model)
            : placement.remote.deliverSteer(chatId, orgId, text, model),
        owns,
        scope: own,
        hostsHarness: true,
        ownsDatabase: false,
        machineDispatch: placement.dispatch,
        recover: async () => {},
        setStreamSink: () => {},
        setTurnEnded: () => {},
        close: async () => {},
      };
    }
  }
}
