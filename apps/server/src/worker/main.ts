// One forked worker process: owns one chat's conversation end to end —
// scoped durable harness, bridge, codemode sandbox, executor envs — and
// serves admission, control, and live frames over the supervisor's IPC
// protocol. Transcript rows and approval decisions cross through Postgres.
// This is the worker process's composition root: it builds its runtime
// from the same parts the server's does, scoped to its chat.

import pino from "pino";
import { ObjectStore } from "../platform/s3.js";
import { createPlatformPool } from "../platform/db.js";
import { createStores } from "../platform/stores.js";
import { masterKeyBytes } from "../platform/crypto.js";
import { clickhouseFromConfig } from "../platform/clickhouse.js";
import { TraceStore } from "../platform/trace.js";
import { AgentStore } from "../agents/store.js";
import { GuildRuntime, type SubmitTurnInput } from "../harness/runtime.js";
import { loadWorkerConfig } from "../config.js";
import type { LiveBuffers } from "../chats/bridge.js";
import { IpcMachineDispatch } from "./dispatch-proxy.js";
import { failure, failureError, type BufferUpdate, type ServerToWorker, type WorkerToServer } from "./protocol.js";

/** How long a worker waits for the server to answer one of its requests. */
const REMOTE_TIMEOUT_MS = 120_000;

const { config, chatId } = loadWorkerConfig(process.env);
const log = pino({ level: config.logLevel });

const pool = createPlatformPool(config.databaseUrl, config.poolMax);
const objects = new ObjectStore(config);
const stores = createStores(pool);
const secretsKey = masterKeyBytes(config.masterKeyHex);

function send(message: WorkerToServer): void {
  if (process.connected) process.send!(message);
}

// The worker's own requests (dispatch, remote admission) share one ref
// space, answered by the server's `reply` frames.
let workerRef = 0;
const nextRef = (): number => (workerRef += 1);
// The worker has no hub connection: machine-tool dispatch proxies to the
// server over the fork IPC channel (worker/dispatch-proxy.ts).
const ipcDispatch = new IpcMachineDispatch((message) => send(message), nextRef);
const remotePending = new Map<
  number,
  { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
>();

/** One worker request to the server, rejected when it times out or the
 *  channel closes. */
function remote(message: Extract<WorkerToServer, { t: "remote-submit" | "remote-deliver-steer" }>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      remotePending.delete(message.ref);
      reject(new Error(`server did not answer ${message.t} in time`));
    }, REMOTE_TIMEOUT_MS);
    timer.unref?.();
    remotePending.set(message.ref, { resolve, reject, timer });
    if (!process.connected) {
      rejectRemote(new Error("worker channel is closed"));
      return;
    }
    send(message);
  });
}

function rejectRemote(error: Error): void {
  for (const pending of remotePending.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  remotePending.clear();
}

// The worker owns its chat's run lifecycle and tool calls, so it writes the
// same traces and spans the server does (the gateway writes the LLM spans).
const trace = new TraceStore(clickhouseFromConfig(config), config.tracePayloads);
const runtime = new GuildRuntime({
  config,
  pool,
  log,
  stores,
  agents: new AgentStore(pool, trace, config.agentWorkspaceWriteRoot),
  masterKey: () => secretsKey,
  objects,
  trace,
  placement: {
    kind: "worker",
    chatId,
    dispatch: ipcDispatch,
    remote: {
      submit: async (targetChatId: string, _orgId: string, input: SubmitTurnInput) =>
        Number(await remote({ t: "remote-submit", ref: nextRef(), chatId: targetChatId, input })),
      deliverSteer: async (targetChatId, orgId, text, model) => {
        await remote({ t: "remote-deliver-steer", ref: nextRef(), chatId: targetChatId, orgId, text, model });
      },
    },
  },
});
let mirrored: LiveBuffers = { text: "", thinking: "" };
const bufferUpdate = (previous: string, current: string): BufferUpdate | undefined =>
  previous === current
    ? undefined
    : current.startsWith(previous)
      ? { append: current.slice(previous.length) }
      : { replace: current };
runtime.setStreamSink({
  open(_chat, generationId) {
    mirrored = { text: "", thinking: "" };
    send({ t: "stream", action: "open", generationId });
  },
  event(_chat, event) {
    send({ t: "stream", action: "event", event });
  },
  dirty() {
    send({ t: "stream", action: "dirty" });
  },
  close() {
    send({ t: "stream", action: "close" });
  },
  buffers(_chat, current) {
    const text = bufferUpdate(mirrored.text, current.text);
    const thinking = bufferUpdate(mirrored.thinking, current.thinking);
    if (text || thinking) send({ t: "stream", action: "buffers", text, thinking });
    mirrored = { ...current };
  },
});

runtime.setTurnEnded(async (endedChatId, failed) => {
  send({ t: "turn-ended", chatId: endedChatId, failed });
});

let heartbeat: NodeJS.Timeout | undefined;

async function shutdown(): Promise<void> {
  if (heartbeat) clearInterval(heartbeat);
  rejectRemote(new Error("worker is shutting down"));
  await runtime.close().catch((error: unknown) => log.warn({ err: error, chatId }, "runtime close failed"));
  await pool.end().catch((error: unknown) => log.warn({ err: error, chatId }, "pool close failed"));
  process.exit(0);
}

// The parent going away (crash, redeploy, close) orphans this worker: exit
// cleanly — the scoped harness close leaves pending work pending, and the
// supervisor's respawn (or the next touch) resumes it.
process.on("disconnect", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

async function main(): Promise<void> {
  await runtime.start();
  heartbeat = setInterval(() => send({ t: "heartbeat" }), 15_000);
  heartbeat.unref?.();
  send({ t: "ready" });
  log.info({ chatId }, "worker ready");
}

process.on("message", (raw: unknown) => {
  const message = raw as ServerToWorker;
  if (!message || typeof message !== "object" || !("t" in message)) return;
  // The server answering one of this worker's requests.
  if (message.t === "reply") {
    const pending = remotePending.get(message.ref);
    if (pending !== undefined) {
      remotePending.delete(message.ref);
      clearTimeout(pending.timer);
      if (message.ok) pending.resolve(message.data);
      else pending.reject(failureError(message));
      return;
    }
    ipcDispatch.onReply(message);
    return;
  }
  const request = message;
  void (async () => {
    try {
      let data: unknown;
      switch (request.t) {
        case "submit":
          data = await runtime.submitTurn(chatId, request.input.orgId, request.input);
          break;
        case "deliver-steer":
          await runtime.deliverChildSteer(chatId, request.orgId, request.text, request.model);
          data = null;
          break;
        case "steer":
          data = await runtime.steerQueued(chatId, request.submissionId);
          break;
        case "withdraw":
          data = await runtime.withdrawQueued(chatId, request.submissionId);
          break;
        case "stop":
          await runtime.stopChat(chatId);
          data = null;
          break;
        case "compact":
          data = await runtime.compactChat(chatId);
          break;
      }
      send({ t: "result", ref: request.ref, ok: true, data });
    } catch (error) {
      send({ t: "result", ref: request.ref, ...failure(error) });
      log.error({ err: error, chatId, kind: request.t }, "worker request failed");
    }
  })();
});

void main().catch((error) => {
  log.error({ err: error, chatId }, "worker failed to start");
  process.exit(1);
});
