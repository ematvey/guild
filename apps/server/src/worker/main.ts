import { ApiError } from "../platform/errors.js";
// One forked worker process: owns one chat's conversation end to end —
// scoped durable harness, bridge, codemode sandbox, executor envs — and
// serves admission, control, and live frames over the supervisor's IPC
// protocol. Transcript rows and approval decisions cross through Postgres.

import pino from "pino";
import { ObjectStore } from "../platform/s3.js";
import { createPlatformPool } from "../platform/db.js";
import { GuildRuntime } from "../harness/runtime.js";
import { loadConfig } from "../config.js";
import type { BufferUpdate, SubmitTurnWireInput, WorkerRequest, WorkerResponse } from "./protocol.js";
import type { LiveBuffers } from "../chats/bridge.js";
import { IpcMachineDispatch } from "./dispatch-proxy.js";
import { ClickhouseClient } from "../platform/clickhouse.js";
import { TraceStore } from "../platform/trace.js";

const config = loadConfig(process.env);
const log = pino({ level: config.logLevel });

const chatId = process.env.GUILD_WORKER_CHAT_ID;
if (!chatId) throw new Error("GUILD_WORKER_CHAT_ID is not set — this entry is forked by the supervisor only");

const pool = createPlatformPool(config.databaseUrl, config.poolMax);
const objects = new ObjectStore(config);
// The worker has no hub connection: machine-tool dispatch proxies to the
// server over the fork IPC channel (worker/dispatch-proxy.ts).
const ipcDispatch = new IpcMachineDispatch((message) => send(message));
const remotePending = new Map<number, { resolve: (value: number) => void; reject: (error: Error) => void }>();
let remoteSeq = 0;
const remoteSubmit = (targetChatId: string, _orgId: string, input: SubmitTurnWireInput): Promise<number> => {
  const ref = 1_000_000 + (remoteSeq += 1);
  return new Promise<number>((resolve, reject) => {
    remotePending.set(ref, { resolve, reject });
    send({ t: "remote-submit", ref, chatId: targetChatId, input });
  });
};
// The worker owns its chat's run lifecycle and tool calls, so it writes the
// same traces and spans the server does (the gateway writes the LLM spans).
const clickhouse = new ClickhouseClient({
  url: config.clickhouseUrl,
  database: config.clickhouseDatabase,
  user: config.clickhouseUser,
  password: config.clickhousePassword,
});
const trace = new TraceStore(clickhouse, config.tracePayloads);
const runtime = new GuildRuntime(config, pool, log, objects, undefined, undefined, trace, undefined, {
  chatId,
  dispatch: ipcDispatch,
  remoteSubmit,
});
let mirrored: LiveBuffers = { text: "", thinking: "" };
const bufferUpdate = (previous: string, current: string): BufferUpdate | undefined =>
  previous === current ? undefined : current.startsWith(previous)
    ? { append: current.slice(previous.length) } : { replace: current };
runtime.setStreamSink({
  open(_chat, generationId) {
    mirrored = { text: "", thinking: "" };
    send({ t: "stream", action: "open", generationId });
  },
  event(_chat, event) { send({ t: "stream", action: "event", event }); },
  dirty() { send({ t: "stream", action: "dirty" }); },
  close() { send({ t: "stream", action: "close" }); },
  buffers(_chat, current) {
    const text = bufferUpdate(mirrored.text, current.text);
    const thinking = bufferUpdate(mirrored.thinking, current.thinking);
    if (text || thinking) send({ t: "stream", action: "buffers", text, thinking });
    mirrored = { ...current };
  },
});

let heartbeat: NodeJS.Timeout | undefined;

async function shutdown(): Promise<void> {
  if (heartbeat) clearInterval(heartbeat);
  await runtime.close().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}

// The parent going away (crash, redeploy, close) orphans this worker: exit
// cleanly — the scoped harness close leaves pending work pending, and the
// supervisor's respawn (or the next touch) resumes it.
process.on("disconnect", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

function send(message: unknown): void {
  if (process.connected) process.send!(message);
}

async function main(): Promise<void> {
  await runtime.start();
  heartbeat = setInterval(() => send({ t: "heartbeat" }), 15_000);
  heartbeat.unref?.();
  send({ t: "ready" });
  log.info({ chatId }, "worker ready");
}

process.on("message", (raw: unknown) => {
  const message = raw as WorkerRequest | WorkerResponse;
  if (!message || typeof message !== "object" || !("t" in message)) return;
  // A dispatch reply (the server answering a worker-initiated proxy call).
  if (message.t === "result") {
    const pending = remotePending.get(message.ref);
    if (pending) {
      remotePending.delete(message.ref);
      if (message.ok) pending.resolve(Number(message.data));
      else pending.reject(new Error(message.error));
      return;
    }
    ipcDispatch.onResponse(message as WorkerResponse);
    return;
  }
  const request = message as WorkerRequest;
  void (async () => {
    try {
      let data: unknown;
      switch (request.t) {
        case "submit":
          data = await runtime.submitTurn(chatId, request.input.orgId, request.input);
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
      send({
        t: "result",
        ref: request.ref,
        ok: false,
        error: (error as Error)?.message ?? String(error),
        ...(error instanceof ApiError ? { status: error.status, code: error.code } : {}),
      });
      log.error({ err: error, chatId, kind: request.t }, "worker request failed");
    }
  })();
});

void main().catch((error) => {
  log.error({ err: error, chatId }, "worker failed to start");
  process.exit(1);
});
